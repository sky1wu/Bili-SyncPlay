const port = Number(process.env.PORT ?? 8787);
import { createSyncServer } from "./app";

const { httpServer } = createSyncServer();
httpServer.listen(port, () => {
  console.log(`Bili-SyncPlay server listening on http://localhost:${port}`);
});
