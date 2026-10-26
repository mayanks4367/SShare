#!/usr/bin/env node

/**
 * SwarmShare Unified Launcher
 *
 * Starts the signaling server (:8787) and frontend dev server (:5173) with a single command.
 * Automatically detects the laptop's LAN IP address, passes it to the frontend via
 * VITE_RECEIVER_BASE_URL and VITE_SIGNALING_URL, and displays a terminal QR code
 * so non-technical users can simply point their Android/iOS phone camera at the screen.
 */

import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "..");
const signalingDir = path.join(rootDir, "signaling");
const frontendDir = path.join(rootDir, "sshareweb", "frontend");
const require = createRequire(import.meta.url);

export function getLanIp() {
  const nets = os.networkInterfaces();
  const candidates = [];

  for (const [name, interfaces] of Object.entries(nets)) {
    if (!interfaces) continue;
    for (const net of interfaces) {
      const isV4 = net.family === "IPv4" || net.family === 4;
      if (isV4 && !net.internal) {
        let score = 0;
        // Priority to Wi-Fi and Ethernet
        if (/^(wlan|wlp|eth|en)/i.test(name)) score += 10;
        // Standard private IP ranges
        if (/^192\.168\./.test(net.address)) score += 5;
        else if (/^10\./.test(net.address)) score += 4;
        else if (/^172\.(1[6-9]|2[0-9]|3[0-1])\./.test(net.address)) score += 4;
        // Deprioritize virtual bridges / VPNs
        if (/^(docker|br-|veth|tailscale|tun)/i.test(name)) score -= 10;

        candidates.push({ address: net.address, score, name });
      }
    }
  }

  candidates.sort((a, b) => b.score - a.score);
  return candidates[0]?.address || "127.0.0.1";
}

function generateTerminalQr(url) {
  try {
    const qrcode = require(path.join(frontendDir, "node_modules", "qrcode-generator"));
    const qr = qrcode(0, "M");
    qr.addData(url);
    qr.make();
    return qr.createASCII(1, 0);
  } catch {
    return null;
  }
}

function printBanner(lanIp, port = 5173, sigPort = 8787) {
  const phoneUrl = `http://${lanIp}:${port}`;
  const laptopUrl = `http://localhost:${port}`;
  const signalUrl = `ws://${lanIp}:${sigPort}/ws`;

  console.log("\n\x1b[36m" + "=".repeat(62) + "\x1b[0m");
  console.log("\x1b[1m\x1b[32m  🌀 SwarmShare — Peer-to-Peer File Transfer\x1b[0m");
  console.log("\x1b[36m" + "=".repeat(62) + "\x1b[0m\n");

  console.log("  \x1b[1m💻 Laptop:\x1b[0m  " + `\x1b[4m${laptopUrl}\x1b[0m`);
  console.log("  \x1b[1m📱 Phone:\x1b[0m   " + `\x1b[1m\x1b[33m\x1b[4m${phoneUrl}\x1b[0m`);
  console.log("  \x1b[1m📡 Signal:\x1b[0m  " + `${signalUrl}\n`);

  const qrText = generateTerminalQr(phoneUrl);
  if (qrText) {
    console.log("  \x1b[1m📲 Scan with your Android/iOS camera to open on your phone:\x1b[0m\n");
    // Indent QR code for clean terminal alignment
    const indented = qrText
      .split("\n")
      .map((line) => "    " + line)
      .join("\n");
    console.log(indented + "\n");
  } else {
    console.log("  Open \x1b[1m" + phoneUrl + "\x1b[0m in your phone's browser.\n");
  }

  console.log("\x1b[90m  Press Ctrl+C at any time to stop all services.\x1b[0m");
  console.log("\x1b[36m" + "=".repeat(62) + "\x1b[0m\n");
}

function start() {
  const lanIp = getLanIp();
  const port = 5173;
  const sigPort = 8787;

  printBanner(lanIp, port, sigPort);

  const children = [];

  const cleanup = () => {
    for (const child of children) {
      try {
        child.kill("SIGTERM");
      } catch {
        /* ignore */
      }
    }
  };

  process.on("SIGINT", () => {
    console.log("\n\x1b[33mShutting down SwarmShare services...\x1b[0m");
    cleanup();
    process.exit(0);
  });

  process.on("SIGTERM", () => {
    cleanup();
    process.exit(0);
  });

  // 1. Signaling service
  const sigProcess = spawn("npm", ["run", "dev"], {
    cwd: signalingDir,
    env: {
      ...process.env,
      PORT: String(sigPort),
      HOST: "0.0.0.0",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  children.push(sigProcess);

  sigProcess.stdout.on("data", (data) => {
    const lines = data.toString().trim().split("\n");
    for (const line of lines) {
      if (line) console.log(`\x1b[35m[signaling]\x1b[0m ${line}`);
    }
  });

  sigProcess.stderr.on("data", (data) => {
    const lines = data.toString().trim().split("\n");
    for (const line of lines) {
      if (line) console.error(`\x1b[35m[signaling]\x1b[0m ${line}`);
    }
  });

  // 2. Frontend service
  const webProcess = spawn("npm", ["run", "dev"], {
    cwd: frontendDir,
    env: {
      ...process.env,
      VITE_RECEIVER_BASE_URL: `http://${lanIp}:${port}`,
      VITE_SIGNALING_URL: `ws://${lanIp}:${sigPort}/ws`,
      VITE_SSHARE_API_URL: `http://${lanIp}:8080`,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  children.push(webProcess);

  webProcess.stdout.on("data", (data) => {
    const lines = data.toString().trim().split("\n");
    for (const line of lines) {
      if (line) console.log(`\x1b[34m[frontend]\x1b[0m ${line}`);
    }
  });

  webProcess.stderr.on("data", (data) => {
    const lines = data.toString().trim().split("\n");
    for (const line of lines) {
      if (line) console.error(`\x1b[34m[frontend]\x1b[0m ${line}`);
    }
  });
}

const isMain = process.argv[1]?.endsWith("start.js") || process.argv[1]?.endsWith("start.mjs");
if (isMain) {
  start();
}
