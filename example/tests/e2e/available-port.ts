import { createServer } from "node:net";

export async function availablePort(): Promise<number> {
  return await new Promise((resolvePort, reject) => {
    const listener = createServer();
    listener.once("error", reject);
    listener.listen(0, "127.0.0.1", () => {
      const address = listener.address();
      if (!address || typeof address === "string") {
        listener.close();
        reject(new Error("Node did not allocate a TCP port"));
        return;
      }
      listener.close((error) => {
        if (error) reject(error);
        else resolvePort(address.port);
      });
    });
  });
}
