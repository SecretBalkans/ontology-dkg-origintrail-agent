import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import {
  CallToolResultSchema,
} from "@modelcontextprotocol/sdk/types.js";

import Anthropic from '@anthropic-ai/sdk';
import { spawn } from 'child_process';
import readline from 'readline';
import dotenv from 'dotenv';
import fs from 'fs/promises';
import path from 'path';
import { randomUUID } from 'crypto';

// Load environment variables
dotenv.config();
function reconstructFromEvents(events) {
  const content = [];
  const contentBlocks = new Map(); // index -> content block

  for (const event of events) {
    if (event.type === 'content_block_start') {
      const block = { ...event.content_block };
      if (block.type === 'text') {
        block.text = '';
      } else if (block.type === 'tool_use') {
        block.input = {};
        block._inputJson = ''; // temporary field
      }
      contentBlocks.set(event.index, block);

    } else if (event.type === 'content_block_delta') {
      const block = contentBlocks.get(event.index);
      if (!block) continue;

      if (event.delta.type === 'text_delta') {
        block.text += event.delta.text;
      } else if (event.delta.type === 'input_json_delta') {
        block._inputJson += event.delta.partial_json;
      }

    } else if (event.type === 'content_block_stop') {
      const block = contentBlocks.get(event.index);
      if (block && block.type === 'tool_use' && block._inputJson) {
        try {
          block.input = JSON.parse(block._inputJson);
          delete block._inputJson;
        } catch (e) {
          console.error('Failed to parse tool input:', e);
        }
      }
      content.push(block);
    }
  }

  return { content };
}

class MCPClient {
  constructor() {
    this.clients = new Map();
    this.anthropic = new Anthropic({
      apiKey: process.env.ANTHROPIC_API_KEY
    });
    this.sequenceId = null;
  }

  async loadPrompt(promptPath) {
    try {
      const fullPath = path.resolve('prompts',promptPath);
      const content = await fs.readFile(fullPath, 'utf-8');
      return content;
    } catch (error) {
      console.error(`Error loading prompt from ${promptPath}:`, error.message);
      throw error;
    }
  }

  async saveOutput(filename, content) {
    const outputDir = path.join('./outputs', this.sequenceId);
    await fs.mkdir(outputDir, { recursive: true });
    const filePath = path.join(outputDir, filename);
    await fs.writeFile(filePath, content, 'utf-8');
    console.log(`Saved output to: ${filePath}`);
    return filePath;
  }

  async connectToServer(serverName, serverConfig) {
    console.log(`\nConnecting to ${serverName}...`);
    console.log(`Command: ${serverConfig.command}`);
    console.log(`Args: ${JSON.stringify(serverConfig.args)}`);

    try {
      // Parse environment variables
      const env = {};
      if (serverConfig.env) {
        for (const [key, value] of Object.entries(serverConfig.env)) {
          env[key] = value;
        }
      }

      // Handle special cases for command paths
      let command = serverConfig.command;
      const args = [...serverConfig.args];

      // Create transport without spawning a separate process
      const transport = new StdioClientTransport({
        command,
        args,
        env: { ...process.env, ...env }
      });

      // Create client
      const client = new Client({
        name: `mcp-client-${serverName}`,
        version: '1.0.0'
      }, {
        capabilities: {
          tools: {}
        }
      });

      // Connect with timeout
      const connectPromise = client.connect(transport);
      const timeoutPromise = new Promise((_, reject) =>
        setTimeout(() => reject(new Error('Connection timeout after 30 seconds')), 30000)
      );

      await Promise.race([connectPromise, timeoutPromise]);

      // Store client (no separate process needed for stdio transport)
      this.clients.set(serverName, { client, transport });

      // List available tools
      const tools = await client.listTools();
      console.log(`Connected to ${serverName} with tools:`, tools.tools.map(t => t.name));

      return client;
    } catch (error) {
      console.error(`Failed to connect to ${serverName}:`, error.message);
      console.error('Make sure the server is properly installed and the command is correct.');
      if (serverName === 'obsidian-api-mcp-server') {
        console.error('For Obsidian MCP server, ensure:');
        console.error('1. uvx is installed (pip install uvx)');
        console.error('2. OBSIDIAN_API_KEY is set in .env');
        console.error('3. Obsidian is running with the Local REST API plugin enabled');
      }
      throw error;
    }
  }

  async connectToSpecificServer(serverName, config) {
    if (config.mcpServers[serverName]) {
      await this.connectToServer(serverName, config.mcpServers[serverName]);
    } else {
      throw new Error(`Server ${serverName} not found in configuration`);
    }
  }

  async processQuery(query, systemPromptPath, serverFilter = null, config) {
    // Collect available tools from specified servers or all servers
    const availableTools = [];
    const toolToServer = new Map();

    for (const [serverName, { client }] of this.clients) {
      if (serverFilter && !serverFilter.includes(serverName)) continue;

      try {
        const tools = await client.listTools();
        for (const tool of tools.tools) {
          availableTools.push({
            name: tool.name,
            description: tool.description,
            input_schema: tool.inputSchema
          });
          toolToServer.set(tool.name, serverName);
        }
        console.log(`${serverName} with tools available:`, tools.tools.map(t => t.name));

      } catch (error) {
        console.error(`Error listing tools for ${serverName}:`, error);
      }
    }

    const messages = [
      {
        role: 'user',
        content: query
      }
    ];

    // Load system prompt if provided
    let systemPrompt = null;
    if (systemPromptPath) {
      systemPrompt = await this.loadPrompt(systemPromptPath);
    }

    // Initial Claude API call
    let MODEL = process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-20250514';
    const MAX_TOKENS = 64_000;
    const apiParams = {
      model: MODEL,
      max_tokens: MAX_TOKENS,
      messages: messages,
      tools: availableTools,
      stream: true,
    };

    // Add system prompt as top-level parameter if provided
    if (systemPrompt) {
      apiParams.system = systemPrompt;
    }

    let stream = await this.anthropic.messages.create(apiParams);

    // Collect all events first, then process
    const events = [];
    for await (const event of stream) {
      events.push(event);
    }
    let response = reconstructFromEvents(events);

    const finalText = [];

    // Continue processing until Claude stops using tools
    let continueProcessing = true;
    let step = 'prompt';
    let verifiedOutput;
    while (continueProcessing) {
      let assistantMessageContent = [];
      let toolUses = [];
      let hasToolUse = false;

      // Now process similar to your original non-streaming code
      // by reconstructing the final message from all events
      for (const content of response.content) {
        if (content.type === 'text') {
          finalText.push(content.text);
          assistantMessageContent.push(content);
        } else if (content.type === 'tool_use') {
          hasToolUse = true;
          assistantMessageContent.push(content);
          toolUses.push(content);
        }
      }


      // If there were tool uses, we need to send the results back to Claude
      if (hasToolUse) {
        // Add the assistant's message with tool uses
        messages.push({
          role: 'assistant',
          content: assistantMessageContent
        });

        // Execute all tool calls and collect results
        const toolResults = [];

        for (const toolUse of toolUses) {
          const toolName = toolUse.name;
          const toolArgs = toolUse.input;
          const serverName = toolToServer.get(toolName);

          if (!serverName) {
            console.error(`Tool ${toolName} not found in any connected server`);
            toolResults.push({
              type: 'tool_result',
              tool_use_id: toolUse.id,
              content: [{ type: 'text', text: `Error: Tool ${toolName} not found` }]
            });
            continue;
          }

          finalText.push(`[Calling tool ${toolName} with args ${JSON.stringify(toolArgs)}]`);

          try {
            // Execute tool call on the appropriate server
            const { client } = this.clients.get(serverName);

            // Debug: log the tool call details
            console.log(`\nExecuting tool: ${toolName}`);
            if(toolName === 'search_vault') {
              toolArgs.context_length = MAX_TOKENS;
            }
            console.log(`Tool arguments:`, JSON.stringify(toolArgs, null, 2));

            const result = await client.request(
              {
                method: "tools/call",
                params: {
                  name: toolName,
                  args: toolArgs,
                },
              },
              CallToolResultSchema
            );

            console.log(`Tool ${toolName} completed successfully`);

            // Handle the tool result properly
            let toolResultContent;
            if (result.content && result.content.length > 0) {
              toolResultContent = result.content;
            } else if (typeof result === 'string') {
              toolResultContent = [{ type: 'text', text: result }];
            } else {
              toolResultContent = [{ type: 'text', text: JSON.stringify(result) }];
            }

            toolResults.push({
              type: 'tool_result',
              tool_use_id: toolUse.id,
              content: toolResultContent
            });
          } catch (error) {
            console.error(`Error calling tool ${toolName}:`, error);
            finalText.push(`[Error calling tool ${toolName}: ${error.message}]`);
            toolResults.push({
              type: 'tool_result',
              tool_use_id: toolUse.id,
              content: [{ type: 'text', text: `Error: ${error.message}` }]
            });
          }
        }

        // Add all tool results as a user message
        messages.push({
          role: 'user',
          content: toolResults
        });

        // Get next response from Claude
        const nextApiParams = {
          model: MODEL,
          max_tokens: MAX_TOKENS,
          messages: messages,
          tools: availableTools,
          stream: true,
        };

        // Maintain system prompt for subsequent calls
        if (systemPrompt) {
          nextApiParams.system = systemPrompt;
        }
        let stream = await this.anthropic.messages.create(nextApiParams);

        // Collect all events first, then process
        const events = [];
        for await (const event of stream) {
          events.push(event);
        }
        response = reconstructFromEvents(events);
      } else {
        // No more tool uses, we're done with first phase

        console.log(finalText.join('\n'));
        if(step.includes('prompt')) {
          // Hacky way to give the opportunity to the user to answer when the initial prompt is used
          let tailorPrompt = await this.getUserObsidianPrompt(
            "Specify an answer for the tailored response");
          tailorPrompt += '\n Make sure to use agent_id `OntologyLink`. Produce the JSON as specified in the schema.';
          messages.push({
            role: 'user',
            content: tailorPrompt
          });

          const nextApiParams = {
            model: MODEL,
            max_tokens: MAX_TOKENS,
            messages: messages,
            stream: true,
          }
          let stream = await this.anthropic.messages.create(apiParams);

          // Collect all events first, then process
          const events = [];
          for await (const event of stream) {
            events.push(event);
          }
          let response = reconstructFromEvents(events);
          verifiedOutput = response.content[0].text;
          step = 'confirm send';
        } else {
          // for validate md.
          console.log("\n--- VERIFIED JSON OUTPUT ---");
          console.log(verifiedOutput);
          console.log("--- END VERIFIED OUTPUT ---\n");

          // Get user verification
          const userConfirmed = await this.getUserConfirmation(
            "Do you want to proceed with verification of this output? (y/n): "
          );

          if (!userConfirmed) {
            console.log("User cancelled the sequence.");
            return;
          }

          // Extract JSON from verified output
          const jsonContent = this.extractJsonFromResponse(verifiedOutput);
          if (!jsonContent) {
            throw new Error("Could not extract valid JSON from verification output");
          }

          // Save verified JSON
          const jsonPath = await this.saveOutput('public.json', jsonContent);
          console.log(`\nVerified JSON saved to: ${jsonPath}`);

          // Step 3: DKG submission
          console.log("\n=== STEP 3: DKG Submission ===");

          // Disconnect from Obsidian and connect to DKG
          await this.cleanup();
          await this.connectToSpecificServer('originTrail', config);

          const dkgPrompt = `Please submit the following verified JSON to the DKG:\n\n${jsonContent}`;
          const dkgResponse = await this.processQuery(dkgPrompt,
            './dkg.md',
            ['originTrail'],
            config,
          );

          console.log("\n--- DKG SUBMISSION RESULT ---");
          console.log(dkgResponse);
          console.log("--- END DKG RESULT ---\n");

        }
      }
    }
  }

  async getUserConfirmation(prompt) {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout
    });

    return new Promise((resolve) => {
      rl.question(prompt, (answer) => {
        rl.close();
        resolve(answer.toLowerCase().trim() === 'y' || answer.toLowerCase().trim() === 'yes');
      });
    });
  }

  async getUserObsidianPrompt(prompt) {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout
    });

    return new Promise((resolve) => {
      rl.question(prompt, (answer) => {
        rl.close();
        resolve(answer);
      });
    });
  }

  extractJsonFromResponse(response) {
    // Try to extract JSON from the response
    const jsonMatch = response.match(/```json\n([\s\S]*?)\n```/);
    if (jsonMatch) {
      return jsonMatch[1];
    }

    // Try to find JSON object directly
    const jsonStart = response.indexOf('{');
    const jsonEnd = response.lastIndexOf('}');
    if (jsonStart !== -1 && jsonEnd !== -1) {
      return response.substring(jsonStart, jsonEnd + 1);
    }

    return null;
  }

  async runSequentialChat(config) {
    this.sequenceId = randomUUID();
    console.log(`\nStarting sequential chat with ID: ${this.sequenceId}\n`);

    try {
      // Step 1: Initial chat with Obsidian vault
      console.log("=== STEP 1: Initial Query with Obsidian Vault ===");
      await this.connectToSpecificServer('obsidian-api-mcp-server', config);
      const initialPrompt = await this.getUserObsidianPrompt("What do you want to do with your Obsidian Vaults?");
      await this.processQuery(initialPrompt, 'prompt.md', ['obsidian-api-mcp-server'], config);

      /*// Step 4: Generate private content
      console.log("\n=== STEP 4: Generate Private Content ===");

      // Reconnect to Obsidian for final step
      await this.cleanup();
      await this.connectToSpecificServer('obsidian-api-mcp-server', config);

      const publicPromptContent = await this.loadPrompt('./public_prompt.md');
      const privateResponse = await this.processQuery(
        publicPromptContent,
        './prompt.md',
        ['obsidian-api-mcp-server']
      );

      // Save private content
      await this.saveOutput('private.md', privateResponse);
*/
      console.log("\n=== SEQUENCE COMPLETED ===");
      console.log(`All outputs saved in: ./outputs/${this.sequenceId}/`);

    } catch (error) {
      console.error(`\nError in sequential chat: ${error.message}`);
      await this.cleanup();
      throw error;
    }
  }

  async cleanup() {
    console.log('\nCleaning up connections...');
    for (const [serverName, { client }] of this.clients) {
      try {
        await client.close();
      } catch (error) {
        console.error(`Error cleaning up ${serverName}:`, error);
      }
    }
    this.clients.clear();
  }
}

// Main execution
async function main() {
  // Your MCP configuration
  const config = {
    mcpServers: {
      "obsidian-api-mcp-server": {
        command: process.env.PYTHON_UVX_PATH || "uvx",
        args: [
          "--from",
          "obsidian-api-mcp-server>=1.0.1",
          "obsidian-api-mcp"
        ],
        env: {
          "OBSIDIAN_API_URL": process.env.OBSIDIAN_API_URL || "http://127.0.0.1:27123/",
          "OBSIDIAN_API_KEY": process.env.OBSIDIAN_API_KEY
        }
      },
      "originTrail": {
        command: process.env.PYTHON_PATH || "python",
        args: [
          process.env.DKG_SERVER_PATH || "dkg_server.py",
          "--transport",
          "stdio"
        ],
        env: {
          "ORIGINTRAIL_NODE_URL": process.env.ORIGINTRAIL_NODE_URL || "https://v6-pegasus-node-03.origin-trail.network:8900",
          "BLOCKCHAIN": process.env.ORIGINTRAIL_BLOCKCHAIN || "BASE_TESTNET",
          "PRIVATE_KEY": process.env.PRIVATE_KEY,
          "GOOGLE_API_KEY": process.env.GOOGLE_API_KEY
        }
      }
    }
  };

  // Add timeout for debugging
  console.log("Starting MCP Sequential Client...");
  console.log("Configuration:", JSON.stringify(config, null, 2));

  const client = new MCPClient();

  try {
    await client.runSequentialChat(config);
  } catch (error) {
    console.error('Fatal error:', error);
    console.error('Stack trace:', error.stack);
  } finally {
    await client.cleanup();
  }
}

// Run the client
main().catch(console.error);
