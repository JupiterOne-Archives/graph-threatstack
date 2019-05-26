/* tslint:disable:no-console */
import {
  createLocalInvocationEvent,
  executeSingleHandlerLocal,
} from "@jupiterone/jupiter-managed-integration-sdk";
import { createLogger, TRACE } from "bunyan";
import { executionHandler } from "../src/index";
import { ThreatStackIntegrationConfig } from "../src/types";

async function run(): Promise<void> {
  const logger = createLogger({ name: "local", level: TRACE });

  const integrationConfig: ThreatStackIntegrationConfig = {
    orgName: process.env.TS_ORG_NAME as string,
    orgId: process.env.TS_ORG_ID as string,
    userId: process.env.TS_USER_ID as string,
    apiKey: process.env.TS_API_KEY as string,
  };

  const invocationArgs = {
    // providerPrivateKey: process.env.PROVIDER_LOCAL_EXECUTION_PRIVATE_KEY
  };

  logger.trace(
    await executeSingleHandlerLocal(
      integrationConfig,
      logger,
      executionHandler,
      invocationArgs,
      createLocalInvocationEvent(),
    ),
    "Execution completed successfully!",
  );
}

run().catch(err => {
  console.error(err);
  process.exit(1);
});
