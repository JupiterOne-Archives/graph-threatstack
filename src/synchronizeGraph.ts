import {
  IntegrationError,
  IntegrationExecutionContext,
  IntegrationExecutionResult,
  PersisterOperationsResult,
  summarizePersisterOperationsResults,
} from "@jupiterone/jupiter-managed-integration-sdk";

import {
  createAccountEntity,
  createAccountRelationships,
  createAgentEntities,
  createAgentFindingMappedRelationship,
} from "./converters";
import initializeContext from "./initializeContext";
import {
  createAgentCache,
  createVulnerabilityCache,
  ThreatStackDataCache,
  ThreatStackVulnerabilityCacheData,
  ThreatStackVulnerabilityCacheEntry,
} from "./threatstack/cache";
import {
  ACCOUNT_AGENT_RELATIONSHIP_TYPE,
  ACCOUNT_ENTITY_TYPE,
  AGENT_ENTITY_TYPE,
  AGENT_FINDING_RELATIONSHIP_TYPE,
  ThreatStackAccountEntity,
  ThreatStackAgentEntity,
  ThreatStackAgentFindingRelationship,
  ThreatStackExecutionContext,
} from "./types";
import { fetchSucceeded } from "./util/fetchSuccess";
import getCVE from "./util/getCVE";

export default async function synchronizeGraph(
  executionContext: IntegrationExecutionContext,
): Promise<IntegrationExecutionResult> {
  const context = initializeContext(executionContext);
  const { cache, logger } = context;

  const results: PersisterOperationsResult[] = [];

  if (
    !(await fetchSucceeded(cache, [
      "onlineAgents",
      "offlineAgents",
      "vulnerabilities",
    ]))
  ) {
    throw new IntegrationError({
      message: "Failed to fetch data from provider",
      expose: true,
    });
  }

  const accountEntity = createAccountEntity(context.instance.config);

  results.push(await synchronizeAccount(context, accountEntity));

  const onlineAgentsCache = createAgentCache(cache, "online");
  const offlineAgentsCache = createAgentCache(cache, "offline");

  const [onlineAgentIds, offlineAgentIds] = await Promise.all([
    onlineAgentsCache.getIds(),
    offlineAgentsCache.getIds(),
  ]);

  const onlineAgents = onlineAgentIds
    ? (await onlineAgentsCache.getEntries(onlineAgentIds)).map(e => e.data!)
    : [];
  const offlineAgents = offlineAgentIds
    ? (await offlineAgentsCache.getEntries(offlineAgentIds)).map(e => e.data!)
    : [];

  const newAgentEntities = [
    ...createAgentEntities(onlineAgents),
    ...createAgentEntities(offlineAgents),
  ];

  results.push(await synchronizeAgentEntities(context, newAgentEntities));
  results.push(
    await synchronizeAccountAgentRelationships(
      context,
      accountEntity,
      newAgentEntities,
    ),
  );

  const vulnerabilitiesCache = createVulnerabilityCache(cache);
  const vulnerabilityIds = await vulnerabilitiesCache.getIds();
  if (vulnerabilityIds.length > 0) {
    results.push(
      await synchronizeVulnerabilities(
        context,
        newAgentEntities,
        vulnerabilityIds,
        vulnerabilitiesCache,
      ),
    );
  } else {
    logger.info(
      "Skipping synchronization of vulnerabilities, received empty collection",
    );
  }

  return {
    operations: summarizePersisterOperationsResults(...results),
  };
}

async function synchronizeAccount(
  context: ThreatStackExecutionContext,
  accountEntity: ThreatStackAccountEntity,
): Promise<PersisterOperationsResult> {
  const { persister, graph } = context;
  const oldAccountEntities = await graph.findAllEntitiesByType<
    ThreatStackAccountEntity
  >(ACCOUNT_ENTITY_TYPE);
  return await persister.publishEntityOperations(
    await persister.processEntities(oldAccountEntities, [accountEntity]),
  );
}

async function synchronizeAgentEntities(
  context: ThreatStackExecutionContext,
  agentEntities: ThreatStackAgentEntity[],
): Promise<PersisterOperationsResult> {
  const { persister, graph } = context;
  const oldAgentEntities = await graph.findEntitiesByType<
    ThreatStackAgentEntity
  >(AGENT_ENTITY_TYPE);
  return await persister.publishEntityOperations(
    await persister.processEntities(oldAgentEntities, agentEntities),
  );
}

async function synchronizeAccountAgentRelationships(
  context: ThreatStackExecutionContext,
  accountEntity: ThreatStackAccountEntity,
  agentEntities: ThreatStackAgentEntity[],
): Promise<PersisterOperationsResult> {
  const { persister, graph } = context;

  return await persister.publishRelationshipOperations(
    persister.processRelationships(
      await graph.findRelationshipsByType(ACCOUNT_AGENT_RELATIONSHIP_TYPE),
      createAccountRelationships(
        accountEntity,
        agentEntities,
        ACCOUNT_AGENT_RELATIONSHIP_TYPE,
      ),
    ),
  );
}

async function synchronizeVulnerabilities(
  context: ThreatStackExecutionContext,
  agents: ThreatStackAgentEntity[],
  vulnerabilityIds: string[],
  vulnerabilityCache: ThreatStackDataCache<
    ThreatStackVulnerabilityCacheEntry,
    ThreatStackVulnerabilityCacheData
  >,
): Promise<PersisterOperationsResult> {
  const { persister, graph } = context;

  const agentsById: { [id: string]: ThreatStackAgentEntity } = {};
  for (const agent of agents || []) {
    agentsById[agent.id] = agent;
  }

  const newVulnerabilityRelationships: ThreatStackAgentFindingRelationship[] = [];

  // Build relationships by iterating ids, dropping raw data after it is processed.
  for (const vulnId of vulnerabilityIds) {
    const {
      vulnerability: vuln,
      vulnerableServers,
    } = await vulnerabilityCache.getData(vulnId);

    const cve = getCVE(vuln.cveNumber, {
      package: vuln.reportedPackage,
      severity: vuln.severity,
      vector: vuln.vectorType,
      findings: vuln.systemPackage,
    });

    cve.targets = [];

    for (const server of vulnerableServers) {
      const agent = agentsById[server.agentId];
      if (agent) {
        if (agent.instanceId) {
          cve.targets.push(agent.instanceId);
        } else {
          cve.targets.push(agent.hostname);
        }
        newVulnerabilityRelationships.push(
          createAgentFindingMappedRelationship(
            agent,
            cve,
            vuln.systemPackage,
            vuln.isSuppressed,
          ),
        );
      }
    }
  }

  const oldVulnerabilityRelationships = await graph.findRelationshipsByType(
    AGENT_FINDING_RELATIONSHIP_TYPE,
  );

  return persister.publishRelationshipOperations(
    await persister.processRelationships(
      oldVulnerabilityRelationships,
      newVulnerabilityRelationships,
    ),
  );
}
