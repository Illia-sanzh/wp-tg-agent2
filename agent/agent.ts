import { main } from "./src/main";
import { log } from "./src/config";

main().catch((e) => log.error(e, "fatal startup error"));
