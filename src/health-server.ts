import { createServer, type Server } from "node:http";

export class HealthServer {
  private server: Server | null = null;

  constructor(
    readonly host: string,
    readonly port: number,
    readonly status: () => Record<string, unknown>,
  ) {}

  async start(): Promise<void> {
    if (this.server) return;
    this.server = createServer((request, response) => {
      if (request.url !== "/health" && request.url !== "/state") {
        response.writeHead(404).end();
        return;
      }
      const payload = this.status();
      const body = JSON.stringify(payload);
      response.writeHead(payload.ok ? 200 : 503, {
        "content-type": "application/json; charset=utf-8",
        "content-length": Buffer.byteLength(body),
      });
      response.end(body);
    });
    await new Promise<void>((resolve, reject) => {
      this.server!.once("error", reject);
      this.server!.listen(this.port, this.host, () => {
        this.server!.off("error", reject);
        resolve();
      });
    });
  }

  async close(): Promise<void> {
    const server = this.server;
    this.server = null;
    if (!server) return;
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
}
