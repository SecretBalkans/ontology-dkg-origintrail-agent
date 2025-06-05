# OntologyLink - Decentralized Knowledge Discovery for Researchers

OntologyLink transforms how researchers discover collaborators and build knowledge networks by creating semantic profiles from personal research notes. Our intelligent analyzer processes researchers' Obsidian vaults, extracting deep knowledge patterns across various domains. The data is structured following specific schemas, creating omprehensive ontological profiles that map not just what you know, but how deeply you know it and how your knowledge connects across disciplines. Finally structured knowledge assets are published to OriginTrail's Decentralized Knowledge Graph (DKG), ensuring permanent, verifiable, and discoverable research profiles.

## Getting Started

### Prerequisites

- Node.js 18+ and npm
- Obsidian with your research vault
- Claude Desktop app (for MCP integration)
- Git

### Set Up MCP Servers
Add the following configuration to Claude desktop. Modify claude_desktop_config.json with the following:

```json
{
    "mcpServers": {
        "originTrail": {
            "command": "python",
            "args": [
                "(path_to_mcp_repo)/dkg_server.py",
                "--transport",
                "stdio"
            ],
            "env": {
                "ORIGINTRAIL_NODE_URL": "https://v6-pegasus-node-03.origin-trail.network:8900",
                "BLOCKCHAIN":"BASE_TESTNET",
                "PRIVATE_KEY":"<YOUR_PRIVATE_KEY>",
                "GOOGLE_API_KEY":"<GOOGLE_API_KEY>"
            }
        },
        "obsidian-api-mcp-server": {
            "command": "(which uvx)/uvx",
            "args": [
                "--from",
                "obsidian-api-mcp-server>=1.0.1",
                "obsidian-api-mcp"
            ], 
            "env": {
                "OBSIDIAN_API_URL": "http://127.0.0.1:27123/",
                "OBSIDIAN_API_KEY": "<Obsidian API Key>"
            }
        }
    }
}
```
For Obsidian part you need to do the following:
1. Install **Local Rest API** from Settings > Plugins > Community Plugins (Browse) in Obsidian and Enable it
2. From the Local Rest API plugin page in Optioms > Settings > Enable Non-Encrypted Http
3. Copy API Key and add it to claude_desktop_config.json

For OriginTrail part do the following:
1. clone MCP repo: https://github.com/OriginTrail/dkg-mcp-server and follow the setup instructions
2. add the proper path to python executable in config
3. add your private key, which is used for publishing data to DKG
4. generate google API_KEY (https://aistudio.google.com/apikey) and add it to config

If you prefer using [Notion](https://developers.notion.com/docs/mcp) or other note keeping tools, just add additional mcp configuraion.
Notion example:
```json
{
  "mcpServers": {
    "notionApi": {
      "command": "npx",
      "args": ["-y", "@notionhq/notion-mcp-server"],
      "env": {
        "OPENAPI_MCP_HEADERS": "{\"Authorization\": \"Bearer ntn_****\", \"Notion-Version\": \"2022-06-28\" }"
      }
    }
  }
}
```

### Try it out!
Use our optimised prompt to generate summary of your research in Obsidian vault and publish your ontological profile to DKG. Interact with Claude by checking and aproving its results. Once data is published to DKG, Claude will return a link to your data.

### Future Work
1. robust server architecture to improve data structuring and analysis
2. intelligent matching engine that runs on top of DKG and connects researchers with the common interests
3. advanced privacy framework which allows selective data sharing
