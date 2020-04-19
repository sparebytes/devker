import * as dotenvFlow from "dotenv-flow";
import dotenvExpand from "dotenv-expand";
export default function loadEnv(options) {
  return dotenvExpand(dotenvFlow.config(options));
}
