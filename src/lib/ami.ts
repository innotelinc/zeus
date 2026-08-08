/**
 * Asterisk Manager Interface (AMI) client.
 *
 * Connects to the Asterisk AMI TCP port (default 5038), authenticates,
 * listens for real-time call and device events, and dispatches them
 * to registered handlers.
 *
 * Protocol: https://docs.asterisk.org/Configuration/Interfaces/Asterisk-Manager-Interface-AMI/
 *
 * Required env vars:
 *   ASTERISK_AMI_HOST     – Asterisk server hostname (default: localhost)
 *   ASTERISK_AMI_PORT     – AMI TCP port (default: 5038)
 *   ASTERISK_AMI_USERNAME – AMI manager username
 *   ASTERISK_AMI_SECRET   – AMI manager secret
 */

import net from "node:net";

// ─── Types ───

export interface AmiEvent {
  event: string;
  [key: string]: string;
}

export interface AmiCall {
  uniqueId: string;
  channel: string;
  callerIdNum: string;
  callerIdName: string;
  connectedLineNum: string;
  ext?: string;
  context?: string;
  direction: "inbound" | "outbound" | "internal";
  startTime: number;
  answerTime: number | null;
  endTime: number | null;
  duration: number;
  bridgeId?: string;
  disposition?: string;
}

export type DeviceState = "NOT_INUSE" | "INUSE" | "BUSY" | "UNAVAILABLE" | "UNKNOWN" | "RINGING" | "INVALID" | "ONHOLD";

export type AmiEventHandler = (event: AmiEvent) => void;

// ─── Config ───

function config() {
  return {
    host: process.env.ASTERISK_AMI_HOST ?? "127.0.0.1",
    port: parseInt(process.env.ASTERISK_AMI_PORT ?? "5038", 10),
    username: process.env.ASTERISK_AMI_USERNAME ?? "",
    secret: process.env.ASTERISK_AMI_SECRET ?? "",
  };
}

// ─── AMI Client ───

export class AmiClient {
  private socket: net.Socket | null = null;
  private buffer = "";
  private actionId = 0;
  private connected = false;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private handlers: AmiEventHandler[] = [];
  private reconnectDelay = 1000;
  private shouldReconnect = true;
  private pendingActions = new Map<string, { resolve: (r: Record<string, string>) => void; reject: (e: Error) => void }>();

  /** Register an event handler. Returns an unsubscribe function. */
  onEvent(handler: AmiEventHandler): () => void {
    this.handlers.push(handler);
    return () => {
      this.handlers = this.handlers.filter((h) => h !== handler);
    };
  }

  /** Connect to AMI and authenticate. */
  async connect(): Promise<void> {
    const cfg = config();
    if (!cfg.username || !cfg.secret) {
      console.warn("AMI: ASTERISK_AMI_USERNAME / ASTERISK_AMI_SECRET not set — skipping AMI connection");
      return;
    }

    this.shouldReconnect = true;
    return new Promise((resolve, reject) => {
      this.socket = net.createConnection({ host: cfg.host, port: cfg.port }, () => {
        this.buffer = "";
        // Wait for the server banner, then login
      });

      this.socket.on("data", (chunk: Buffer) => {
        this.buffer += chunk.toString("utf8");
        this.processBuffer(resolve, reject);
      });

      this.socket.on("close", () => {
        this.connected = false;
        this.buffer = "";
        console.warn("AMI: Connection closed");
        this.scheduleReconnect();
      });

      this.socket.on("error", (err: Error) => {
        this.connected = false;
        console.error("AMI: Socket error:", err.message);
        if (!this.connected) {
          this.scheduleReconnect();
        }
      });

      setTimeout(() => {
        if (!this.connected) {
          reject(new Error("AMI connection timed out"));
        }
      }, 10_000);
    });
  }

  /** Send an action and wait for the response. */
  async sendAction(action: Record<string, string>): Promise<Record<string, string>> {
    if (!this.socket) throw new Error("Not connected");

    const id = String(++this.actionId);
    const full = { ...action, ActionID: id };

    let msg = "";
    for (const [k, v] of Object.entries(full)) {
      msg += `${k}: ${v}\r\n`;
    }
    msg += "\r\n";

    return new Promise((resolve, reject) => {
      this.pendingActions.set(id, { resolve, reject });
      this.socket!.write(msg);
      // Timeout after 10s
      setTimeout(() => {
        if (this.pendingActions.has(id)) {
          this.pendingActions.delete(id);
          reject(new Error(`AMI action ${action.Action} timed out`));
        }
      }, 10_000);
    });
  }

  /** Send an action without waiting for a response (fire-and-forget). */
  sendActionAsync(action: Record<string, string>): void {
    if (!this.socket) return;
    const id = String(++this.actionId);
    let msg = "";
    for (const [k, v] of Object.entries({ ...action, ActionID: id })) {
      msg += `${k}: ${v}\r\n`;
    }
    msg += "\r\n";
    this.socket.write(msg);
  }

  /** Disconnect and stop reconnecting. */
  disconnect(): void {
    this.shouldReconnect = false;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.socket?.destroy();
    this.socket = null;
    this.connected = false;
  }

  get isConnected(): boolean {
    return this.connected;
  }

  /** Ping to keep connection alive. */
  async ping(): Promise<boolean> {
    try {
      await this.sendAction({ Action: "Ping" });
      return true;
    } catch {
      return false;
    }
  }

  // ─── Internal ───

  private processBuffer(
    connectResolve?: (value: void) => void,
    connectReject?: (e: Error) => void,
  ): void {
    // Process complete messages (terminated by \r\n\r\n)
    while (true) {
      const idx = this.buffer.indexOf("\r\n\r\n");
      if (idx === -1) break;

      const msg = this.buffer.slice(0, idx);
      this.buffer = this.buffer.slice(idx + 4);

      const parsed = this.parseMessage(msg);
      if (!parsed) continue;

      // Handle login response
      if (parsed.Response === "Success" && !this.connected) {
        this.connected = true;
        console.log("AMI: Connected and authenticated");
        this.reconnectDelay = 1000;
        connectResolve?.();
        continue;
      }

      if (parsed.Response === "Error") {
        if (!this.connected) {
          const err = new Error(`AMI auth failed: ${parsed.Message ?? "Unknown"}`);
          connectReject?.(err);
          this.scheduleReconnect();
        }
        // Resolve/reject pending action
        if (parsed.ActionID && this.pendingActions.has(parsed.ActionID)) {
          const p = this.pendingActions.get(parsed.ActionID)!;
          this.pendingActions.delete(parsed.ActionID);
          p.reject(new Error(parsed.Message ?? "AMI error"));
        }
        continue;
      }

      // Handle action response
      if (parsed.ActionID && parsed.Response === "Success") {
        if (this.pendingActions.has(parsed.ActionID)) {
          const p = this.pendingActions.get(parsed.ActionID)!;
          this.pendingActions.delete(parsed.ActionID);
          p.resolve(parsed);
        }
      }

      // Handle event
      if (parsed.Event) {
        this.dispatch(parsed as AmiEvent);
      }
    }
  }

  private parseMessage(raw: string): Record<string, string> | null {
    const result: Record<string, string> = {};
    const lines = raw.split("\r\n");

    for (const line of lines) {
      // Skip empty lines
      if (!line.trim()) continue;

      const colIdx = line.indexOf(":");
      if (colIdx === -1) continue;

      const key = line.slice(0, colIdx).trim();
      let value = line.slice(colIdx + 1);

      // Trim leading space after colon (AMI standard)
      if (value.startsWith(" ")) value = value.slice(1);
      value = value.trimEnd();

      // Multi-line values: subsequent lines start with space
      // We handle this by appending to the last key
      if (key === "" && result._lastKey) {
        result[result._lastKey] += "\n" + value;
        continue;
      }

      result[key] = value;
      result._lastKey = key;
    }

    delete result._lastKey;
    return Object.keys(result).length > 0 ? result : null;
  }

  private dispatch(event: AmiEvent): void {
    for (const handler of this.handlers) {
      try {
        handler(event);
      } catch (e) {
        console.error("AMI: Handler error:", e);
      }
    }
  }

  private scheduleReconnect(): void {
    if (!this.shouldReconnect) return;
    if (this.reconnectTimer) return;

    console.log(`AMI: Reconnecting in ${this.reconnectDelay}ms...`);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.reconnectDelay = Math.min(this.reconnectDelay * 2, 30_000);
      this.connect().catch(() => {
        // Already handled by scheduleReconnect
      });
    }, this.reconnectDelay);
  }
}

// ─── Singleton ───

let _client: AmiClient | null = null;

export function getAmiClient(): AmiClient {
  if (!_client) {
    _client = new AmiClient();
  }
  return _client;
}

/** Start the AMI client and auto-login with Events: on. */
export async function startAmi(): Promise<AmiClient> {
  const client = getAmiClient();

  // Auto-login and subscribe to all events
  client.onEvent(async (event) => {
    // On first connect, request full events
    if (event.Event === "FullyBooted") {
      await client.sendAction({ Action: "Events", EventMask: "on" }).catch(() => {});
      console.log("AMI: Subscribed to all events");
    }
  });

  await client.connect();

  // Login after connection
  const cfg = config();
  if (cfg.username && cfg.secret) {
    const loginMsg = `Action: Login\r\nUsername: ${cfg.username}\r\nSecret: ${cfg.secret}\r\nEvents: on\r\n\r\n`;
    client["socket"]?.write(loginMsg);
  }

  // Heartbeat every 30s
  setInterval(() => {
    client.ping().catch(() => {});
  }, 30_000).unref();

  return client;
}
