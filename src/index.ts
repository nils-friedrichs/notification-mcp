#!/usr/bin/env node

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { exec, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const execAsync = promisify(exec);
const execFileAsync = promisify(execFile);

// Get the directory where this script is located (works with npx!)
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Available sound files
const SOUND_FILES = {
  cosmic: 'sounds/cosmic_chime.mp3',
  fairy: 'sounds/fairy_chime.mp3',
  gentle: 'sounds/gentle_chime.mp3',
  pleasant: 'sounds/pleasant_chime.mp3',
  retro: 'sounds/retro_chime.mp3'
};

// Get configured sound from environment variables
const DEFAULT_SOUND_NAME = process.env.MCP_NOTIFICATION_SOUND || 'gentle';
const USER_CONFIGURED_SOUND_PATH = process.env.MCP_NOTIFICATION_SOUND_PATH;

// Function to get a random sound
function getRandomSound(): string {
  const soundKeys = Object.keys(SOUND_FILES) as (keyof typeof SOUND_FILES)[];
  const randomKey = soundKeys[Math.floor(Math.random() * soundKeys.length)];
  return SOUND_FILES[randomKey];
}

// Determine which sound file to use
function getSoundFile(soundName?: string): string {
  if (soundName) {
    if (soundName === 'random') {
      return path.join(__dirname, '..', getRandomSound());
    }
    const soundFile = SOUND_FILES[soundName as keyof typeof SOUND_FILES];
    if (soundFile) {
      return path.join(__dirname, '..', soundFile);
    }
  }

  if (USER_CONFIGURED_SOUND_PATH) {
    return USER_CONFIGURED_SOUND_PATH;
  }
  
  if (DEFAULT_SOUND_NAME === 'random') {
    return path.join(__dirname, '..', getRandomSound());
  }
  
  const DEFAULT_SOUND_FILE = SOUND_FILES[DEFAULT_SOUND_NAME as keyof typeof SOUND_FILES] || SOUND_FILES.gentle;
  return path.join(__dirname, '..', DEFAULT_SOUND_FILE);
}

/**
 * Cross-platform helper to play sound file.
 */
async function playSound(soundPath: string): Promise<void> {
  if (process.platform === 'win32') {
    await execAsync(`start "" "${soundPath}"`);
  } else if (process.platform === 'darwin') {
    await execAsync(`afplay "${soundPath}"`);
  } else {
    // Linux support: try available audio players sequentially
    const players = [
      { cmd: 'mpg123', args: ['-q', soundPath] },
      { cmd: 'pw-play', args: [soundPath] },
      { cmd: 'mpv', args: ['--no-video', soundPath] },
      { cmd: 'ffplay', args: ['-nodisp', '-autoexit', soundPath] },
      { cmd: 'paplay', args: [soundPath] }
    ];

    let played = false;
    let lastError: Error | null = null;
    for (const player of players) {
      try {
        await execFileAsync(player.cmd, player.args);
        played = true;
        break;
      } catch (error) {
        lastError = error as Error;
      }
    }
    if (!played) {
      throw new Error(`No audio player succeeded. Last error: ${lastError?.message || 'unknown error'}`);
    }
  }
}

/**
 * Cross-platform helper to show toast notifications.
 */
async function showToast(title: string, message: string): Promise<void> {
  const cleanTitle = title || "Task Completed";
  
  if (process.platform === 'darwin') {
    // macOS: display notification via AppleScript
    const script = `display notification ${JSON.stringify(message)} with title ${JSON.stringify(cleanTitle)}`;
    await execFileAsync('osascript', ['-e', script]);
  } else if (process.platform === 'win32') {
    // Windows: powershell balloon tip notification
    const safeTitle = cleanTitle.replace(/'/g, "''");
    const safeMessage = message.replace(/'/g, "''");
    
    const psCommand = `
      [void] [System.Reflection.Assembly]::LoadWithPartialName('System.Windows.Forms');
      $bal = New-Object System.Windows.Forms.NotifyIcon;
      $bal.Icon = [System.Drawing.SystemIcons]::Information;
      $bal.BalloonTipIcon = 'Info';
      $bal.BalloonTipTitle = '${safeTitle}';
      $bal.BalloonTipText = '${safeMessage}';
      $bal.Visible = $true;
      $bal.ShowBalloonTip(10000);
    `.trim().replace(/\s+/g, ' ');
    
    await execFileAsync('powershell', ['-Command', psCommand]);
  } else {
    // Linux: notify-send (arguments passed securely via execFile)
    await execFileAsync('notify-send', [cleanTitle, message]);
  }
}

/**
 * Create an MCP server with tool capability for playing notifications and showing toasts
 */
const server = new Server(
  {
    name: "notification-mcp",
    version: "0.2.0",
  },
  {
    capabilities: {
      tools: {},
    },
  }
);

/**
 * Handler that lists available tools.
 * Exposes "play_notification" and "notify" tools.
 */
server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: [
      {
        name: "play_notification",
        description: "Play a notification sound to indicate task completion",
        inputSchema: {
          type: "object",
          properties: {
            message: {
              type: "string",
              description: "Optional message to display with notification"
            }
          }
        }
      },
      {
        name: "notify",
        description: "Show a toast notification and/or play a sound when tasks complete",
        inputSchema: {
          type: "object",
          properties: {
            message: {
              type: "string",
              description: "The notification message/summary of the completed task"
            },
            title: {
              type: "string",
              description: "Optional title for the toast notification (defaults to 'Task Completed')"
            },
            mode: {
              type: "string",
              enum: ["toast", "sound", "both"],
              description: "The notification mode to use (defaults to 'both')"
            },
            sound: {
              type: "string",
              enum: ["cosmic", "fairy", "gentle", "pleasant", "retro", "random"],
              description: "Optional sound name override"
            }
          },
          required: ["message"]
        }
      }
    ]
  };
});

/**
 * Handler for tool execution.
 */
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  if (name === "play_notification") {
    try {
      const SOUND_FILE_TO_PLAY = getSoundFile();
      await playSound(SOUND_FILE_TO_PLAY);

      return {
        content: [{
          type: "text",
          text: args?.message
            ? `Notification played: ${args.message}`
            : "Notification played successfully"
        }]
      };
    } catch (error) {
      return {
        content: [{
          type: "text",
          text: `Failed to play notification: ${error instanceof Error ? error.message : String(error)}`
        }],
        isError: true
      };
    }
  }

  if (name === "notify") {
    try {
      const message = String(args?.message || "");
      const title = String(args?.title || "Task Completed");
      const mode = String(args?.mode || "both");
      const soundOverride = args?.sound ? String(args.sound) : undefined;

      const actions: string[] = [];

      if (mode === "toast" || mode === "both") {
        await showToast(title, message);
        actions.push("Toast notification displayed");
      }

      if (mode === "sound" || mode === "both") {
        const soundFile = getSoundFile(soundOverride);
        await playSound(soundFile);
        actions.push("Sound notification played");
      }

      return {
        content: [{
          type: "text",
          text: `${actions.join(" and ")}: ${message}`
        }]
      };
    } catch (error) {
      return {
        content: [{
          type: "text",
          text: `Notification failed: ${error instanceof Error ? error.message : String(error)}`
        }],
        isError: true
      };
    }
  }

  throw new Error("Unknown tool");
});

/**
 * Start the server using stdio transport
 */
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(`Notification MCP server running`);
}

main().catch((error) => {
  console.error("Server error:", error);
  process.exit(1);
});

