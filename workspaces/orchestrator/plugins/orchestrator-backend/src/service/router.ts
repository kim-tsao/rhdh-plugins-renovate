/*
 * Copyright Red Hat, Inc.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import { MiddlewareFactory } from '@backstage/backend-defaults/rootHttpRouter';
import {
  HttpAuthService,
  LoggerService,
  PermissionsService,
  SchedulerService,
} from '@backstage/backend-plugin-api';
import type { Config } from '@backstage/config';
import type { DiscoveryApi } from '@backstage/core-plugin-api';
import {
  AuthorizePermissionRequest,
  AuthorizePermissionResponse,
  AuthorizeResult,
  BasicPermission,
} from '@backstage/plugin-permission-common';
import { createPermissionIntegrationRouter } from '@backstage/plugin-permission-node';
import type { JsonObject, JsonValue } from '@backstage/types';

import { UnauthorizedError } from '@backstage-community/plugin-rbac-common';
import {
  AuditLogger,
  DefaultAuditLogger,
} from '@janus-idp/backstage-plugin-audit-log-node';
import { fullFormats } from 'ajv-formats/dist/formats';
import express, { Router } from 'express';
import { Request as HttpRequest } from 'express-serve-static-core';
import { OpenAPIBackend, Request } from 'openapi-backend';

import {
  Filter,
  openApiDocument,
  orchestratorPermissions,
  orchestratorWorkflowPermission,
  orchestratorWorkflowSpecificPermission,
  orchestratorWorkflowUsePermission,
  orchestratorWorkflowUseSpecificPermission,
  QUERY_PARAM_BUSINESS_KEY,
  QUERY_PARAM_INCLUDE_ASSESSMENT,
  WorkflowOverviewListResultDTO,
} from '@red-hat-developer-hub/backstage-plugin-orchestrator-common';

import { RouterOptions } from '../routerWrapper';
import { buildPagination } from '../types/pagination';
import { V2 } from './api/v2';
import { INTERNAL_SERVER_ERROR_MESSAGE } from './constants';
import { DataIndexService } from './DataIndexService';
import { DataInputSchemaService } from './DataInputSchemaService';
import { OrchestratorService } from './OrchestratorService';
import { ScaffolderService } from './ScaffolderService';
import { SonataFlowService } from './SonataFlowService';
import { WorkflowCacheService } from './WorkflowCacheService';

interface PublicServices {
  dataInputSchemaService: DataInputSchemaService;
  orchestratorService: OrchestratorService;
}

interface RouterApi {
  openApiBackend: OpenAPIBackend;
  v2: V2;
}

const authorize = async (
  request: HttpRequest,
  anyOfPermissions: BasicPermission[],
  permissionsSvc: PermissionsService,
  httpAuth: HttpAuthService,
): Promise<AuthorizePermissionResponse> => {
  const credentials = await httpAuth.credentials(request);

  const decisionResponses: AuthorizePermissionResponse[][] = await Promise.all(
    anyOfPermissions.map(permission =>
      permissionsSvc.authorize([{ permission }], {
        credentials,
      }),
    ),
  );
  const decisions: AuthorizePermissionResponse[] = decisionResponses.map(
    d => d[0],
  );

  const allow = decisions.find(d => d.result === AuthorizeResult.ALLOW);
  return (
    allow || {
      result: AuthorizeResult.DENY,
    }
  );
};

const filterAuthorizedWorkflowIds = async (
  request: HttpRequest,
  permissionsSvc: PermissionsService,
  httpAuth: HttpAuthService,
  workflowIds: string[],
): Promise<string[]> => {
  const credentials = await httpAuth.credentials(request);
  const genericWorkflowPermissionDecision = await permissionsSvc.authorize(
    [{ permission: orchestratorWorkflowPermission }],
    {
      credentials,
    },
  );

  if (genericWorkflowPermissionDecision[0].result === AuthorizeResult.ALLOW) {
    // The user can see all workflows
    return workflowIds;
  }

  const specificWorkflowRequests: AuthorizePermissionRequest[] =
    workflowIds.map(workflowId => ({
      permission: orchestratorWorkflowSpecificPermission(workflowId),
    }));

  const decisions = await permissionsSvc.authorize(specificWorkflowRequests, {
    credentials,
  });

  return workflowIds.filter(
    (_, idx) => decisions[idx].result === AuthorizeResult.ALLOW,
  );
};

const filterAuthorizedWorkflows = async (
  request: HttpRequest,
  permissionsSvc: PermissionsService,
  httpAuth: HttpAuthService,
  workflows: WorkflowOverviewListResultDTO,
): Promise<WorkflowOverviewListResultDTO> => {
  if (!workflows.overviews) {
    return workflows;
  }

  const authorizedWorkflowIds = await filterAuthorizedWorkflowIds(
    request,
    permissionsSvc,
    httpAuth,
    workflows.overviews.map(w => w.workflowId),
  );

  const filtered = {
    ...workflows,
    overviews: workflows.overviews.filter(w =>
      authorizedWorkflowIds.includes(w.workflowId),
    ),
  };

  return filtered;
};

export async function createBackendRouter(
  options: RouterOptions,
): Promise<Router> {
  const {
    config,
    logger,
    discovery,
    catalogApi,
    urlReader,
    scheduler,
    permissions,
    auth,
    httpAuth,
  } = options;
  const publicServices = initPublicServices(logger, config, scheduler);

  const routerApi = await initRouterApi(publicServices.orchestratorService);

  const auditLogger = new DefaultAuditLogger({
    logger: logger,
    authService: auth,
    httpAuthService: httpAuth,
  });

  const router = Router();
  const permissionsIntegrationRouter = createPermissionIntegrationRouter({
    permissions: orchestratorPermissions,
  });
  router.use(express.json());
  router.use(permissionsIntegrationRouter);
  router.use('/workflows', express.text());
  router.get('/health', (_, response) => {
    logger.info('PONG!');
    response.json({ status: 'ok' });
  });

  const scaffolderService: ScaffolderService = new ScaffolderService(
    logger,
    config,
    catalogApi,
    urlReader,
  );

  setupInternalRoutes(
    publicServices,
    routerApi,
    permissions,
    httpAuth,
    auditLogger,
    logger,
  );
  setupExternalRoutes(router, discovery, scaffolderService, auditLogger);

  router.use((req, res, next) => {
    if (!next) {
      throw new Error('next is undefined');
    }

    return routerApi.openApiBackend
      .handleRequest(req as Request, req, res, next)
      .catch(error => {
        auditLogger.auditLog({
          eventName: 'genericErrorHandler',
          stage: 'completion',
          status: 'failed',
          level: 'error',
          request: req,
          message: `Exception thrown during processing request ${req.path} , ${error.message || error.name || error}`,
          errors: [error],
        });

        next(error);
      });
  });

  const middleware = MiddlewareFactory.create({ logger, config });

  router.use(middleware.error());

  return router;
}

function initPublicServices(
  logger: LoggerService,
  config: Config,
  scheduler: SchedulerService,
): PublicServices {
  const dataIndexUrl = config.getString('orchestrator.dataIndexService.url');
  const dataIndexService = new DataIndexService(dataIndexUrl, logger);
  const sonataFlowService = new SonataFlowService(dataIndexService, logger);

  const workflowCacheService = new WorkflowCacheService(
    logger,
    dataIndexService,
    sonataFlowService,
  );
  workflowCacheService.schedule({ scheduler: scheduler });

  const orchestratorService = new OrchestratorService(
    sonataFlowService,
    dataIndexService,
    workflowCacheService,
  );

  const dataInputSchemaService = new DataInputSchemaService();

  return {
    orchestratorService,
    dataInputSchemaService,
  };
}

async function initRouterApi(
  orchestratorService: OrchestratorService,
): Promise<RouterApi> {
  const openApiBackend = new OpenAPIBackend({
    definition: openApiDocument,
    strict: false,
    ajvOpts: {
      strict: false,
      strictSchema: false,
      verbose: true,
      addUsedSchema: false,
      formats: fullFormats, // open issue: https://github.com/openapistack/openapi-backend/issues/280
    },
    handlers: {
      validationFail: async (
        c,
        _req: express.Request,
        res: express.Response,
      ) => {
        console.log('validationFail', c.operation);
        res.status(400).json({ err: c.validation.errors });
      },
      notFound: async (_c, req: express.Request, res: express.Response) => {
        res.status(404).json({ err: `${req.path} path not found` });
      },
      notImplemented: async (_c, req: express.Request, res: express.Response) =>
        res.status(500).json({ err: `${req.path} not implemented` }),
    },
  });
  await openApiBackend.init();
  const v2 = new V2(orchestratorService);
  return { v2, openApiBackend };
}

// ======================================================
// Internal Backstage API calls to delegate to SonataFlow
// ======================================================
function setupInternalRoutes(
  services: PublicServices,
  routerApi: RouterApi,
  permissions: PermissionsService,
  httpAuth: HttpAuthService,
  auditLogger: AuditLogger,
  logger: LoggerService,
) {
  function manageDenyAuthorization(
    endpointName: string,
    endpoint: string,
    req: HttpRequest,
  ) {
    const error = new UnauthorizedError();
    auditLogger.auditLog({
      eventName: `${endpointName}EndpointHit`,
      stage: 'authorization',
      status: 'failed',
      level: 'error',
      request: req,
      response: {
        status: 403,
        body: {
          errors: [
            {
              name: error.name,
              message: error.message,
            },
          ],
        },
      },
      errors: [error],
      message: `Not authorize to request the ${endpoint} endpoint`,
    });
    throw error;
  }

  function auditLogRequestError(
    error: any,
    endpointName: string,
    endpoint: string,
    req: HttpRequest,
  ) {
    logger.error(
      `request to endpoint ${endpoint} failed with error: ${JSON.stringify(error)}. Request headers: ${JSON.stringify(req.headers)}. Request body: ${JSON.stringify(req.body)}. Request query: ${JSON.stringify(req.query)}`,
    );
    auditLogger.auditLog({
      eventName: `${endpointName}EndpointHit`,
      stage: 'completion',
      status: 'failed',
      level: 'error',
      request: req,
      response: {
        status: 500,
        body: {
          errors: [
            {
              name: error.name,
              message: error.message || INTERNAL_SERVER_ERROR_MESSAGE,
            },
          ],
        },
      },
      errors: [error],
      message: `Error occured while requesting the '${endpoint}' endpoint`,
    });
  }

  // v2
  routerApi.openApiBackend.register(
    'getWorkflowsOverview',
    async (_c, req, res: express.Response, next) => {
      const endpointName = 'getWorkflowsOverview';
      const endpoint = '/v2/workflows/overview';

      auditLogger.auditLog({
        eventName: 'getWorkflowsOverview',
        stage: 'start',
        status: 'succeeded',
        level: 'debug',
        request: req,
        message: `Received request to '${endpoint}' endpoint`,
      });

      try {
        const result = await routerApi.v2.getWorkflowsOverview(
          buildPagination(req),
          getRequestFilters(req),
        );

        const workflows = await filterAuthorizedWorkflows(
          req,
          permissions,
          httpAuth,
          result,
        );
        res.json(workflows);
      } catch (error) {
        auditLogRequestError(error, endpointName, endpoint, req);
        next(error);
      }
    },
  );

  // v2
  routerApi.openApiBackend.register(
    'getWorkflowSourceById',
    async (c, _req, res, next) => {
      const workflowId = c.request.params.workflowId as string;
      const endpointName = 'getWorkflowSourceById';
      const endpoint = `/v2/workflows/${workflowId}/source`;

      auditLogger.auditLog({
        eventName: endpointName,
        stage: 'start',
        status: 'succeeded',
        level: 'debug',
        request: _req,
        message: `Received request to '${endpoint}' endpoint`,
      });

      const decision = await authorize(
        _req,
        [
          orchestratorWorkflowPermission,
          orchestratorWorkflowSpecificPermission(workflowId),
        ],
        permissions,
        httpAuth,
      );
      if (decision.result === AuthorizeResult.DENY) {
        manageDenyAuthorization(endpointName, endpoint, _req);
      }

      try {
        const result = await routerApi.v2.getWorkflowSourceById(workflowId);
        res.status(200).contentType('text/plain').send(result);
      } catch (error) {
        auditLogRequestError(error, endpointName, endpoint, _req);
        next(error);
      }
    },
  );

  // v2
  routerApi.openApiBackend.register(
    'executeWorkflow',
    async (c, req: express.Request, res: express.Response, next) => {
      const workflowId = c.request.params.workflowId as string;
      const endpointName = 'executeWorkflow';
      const endpoint = `/v2/workflows/${workflowId}/execute`;

      auditLogger.auditLog({
        eventName: endpointName,
        stage: 'start',
        status: 'succeeded',
        level: 'debug',
        request: req,
        message: `Received request to '${endpoint}' endpoint`,
      });

      const decision = await authorize(
        req,
        [
          orchestratorWorkflowUsePermission,
          orchestratorWorkflowUseSpecificPermission(workflowId),
        ],
        permissions,
        httpAuth,
      );
      if (decision.result === AuthorizeResult.DENY) {
        manageDenyAuthorization(endpointName, endpoint, req);
      }

      const businessKey = routerApi.v2.extractQueryParam(
        c.request,
        QUERY_PARAM_BUSINESS_KEY,
      );

      const executeWorkflowRequestDTO = req.body;

      return routerApi.v2
        .executeWorkflow(executeWorkflowRequestDTO, workflowId, businessKey)
        .then(result => res.status(200).json(result))
        .catch(error => {
          auditLogRequestError(error, endpointName, endpoint, req);
          next(error);
        });
    },
  );

  // v2
  routerApi.openApiBackend.register(
    'retriggerInstance',
    async (c, req: express.Request, res: express.Response, next) => {
      const workflowId = c.request.params.workflowId as string;
      const instanceId = c.request.params.instanceId as string;
      const endpointName = 'retriggerInstance';
      const endpoint = `/v2/workflows/${workflowId}/${instanceId}/retrigger`;

      auditLogger.auditLog({
        eventName: endpointName,
        stage: 'start',
        status: 'succeeded',
        level: 'debug',
        request: req,
        message: `Received request to '${endpoint}' endpoint`,
      });

      const decision = await authorize(
        req,
        [
          orchestratorWorkflowUsePermission,
          orchestratorWorkflowUseSpecificPermission(workflowId),
        ],
        permissions,
        httpAuth,
      );
      if (decision.result === AuthorizeResult.DENY) {
        manageDenyAuthorization(endpointName, endpoint, req);
      }

      await routerApi.v2
        .retriggerInstance(workflowId, instanceId)
        .then(result => res.status(200).json(result))
        .catch(error => {
          auditLogRequestError(error, endpointName, endpoint, req);
          next(error);
        });
    },
  );

  // v2
  routerApi.openApiBackend.register(
    'getWorkflowOverviewById',
    async (c, _req: express.Request, res: express.Response, next) => {
      const workflowId = c.request.params.workflowId as string;
      const endpointName = 'getWorkflowOverviewById';
      const endpoint = `/v2/workflows/${workflowId}/overview`;

      auditLogger.auditLog({
        eventName: endpointName,
        stage: 'start',
        status: 'succeeded',
        level: 'debug',
        request: _req,
        message: `Received request to '${endpoint}' endpoint`,
      });

      const decision = await authorize(
        _req,
        [
          orchestratorWorkflowPermission,
          orchestratorWorkflowSpecificPermission(workflowId),
        ],
        permissions,
        httpAuth,
      );
      if (decision.result === AuthorizeResult.DENY) {
        manageDenyAuthorization(endpointName, endpoint, _req);
      }

      return routerApi.v2
        .getWorkflowOverviewById(workflowId)
        .then(result => res.json(result))
        .catch(error => {
          auditLogRequestError(error, endpointName, endpoint, _req);
          next(error);
        });
    },
  );

  // v2
  routerApi.openApiBackend.register(
    'getWorkflowStatuses',
    async (_c, _req: express.Request, res: express.Response, next) => {
      const endpointName = 'getWorkflowStatuses';
      const endpoint = '/v2/workflows/instances/statuses';

      auditLogger.auditLog({
        eventName: endpointName,
        stage: 'start',
        status: 'succeeded',
        level: 'debug',
        request: _req,
        message: `Received request to '${endpoint}' endpoint`,
      });
      // Anyone is authorized to call this endpoint

      return routerApi.v2
        .getWorkflowStatuses()
        .then(result => res.status(200).json(result))
        .catch(error => {
          auditLogRequestError(error, endpointName, endpoint, _req);
          next(error);
        });
    },
  );

  // v2
  routerApi.openApiBackend.register(
    'getWorkflowInputSchemaById',
    async (c, req: express.Request, res: express.Response, next) => {
      const workflowId = c.request.params.workflowId as string;
      const instanceId = c.request.query.instanceId as string;
      const endpointName = 'getWorkflowInputSchemaById';
      const endpoint = `/v2/workflows/${workflowId}/inputSchema`;
      try {
        auditLogger.auditLog({
          eventName: endpointName,
          stage: 'start',
          status: 'succeeded',
          level: 'debug',
          request: req,
          message: `Received request to '${endpoint}' endpoint`,
        });
        const decision = await authorize(
          req,
          [
            orchestratorWorkflowPermission,
            orchestratorWorkflowSpecificPermission(workflowId),
          ],
          permissions,
          httpAuth,
        );
        if (decision.result === AuthorizeResult.DENY) {
          manageDenyAuthorization(endpointName, endpoint, req);
        }

        const workflowDefinition =
          await services.orchestratorService.fetchWorkflowInfo({
            definitionId: workflowId,
            cacheHandler: 'throw',
          });

        if (!workflowDefinition) {
          throw new Error(
            `Failed to fetch workflow info for workflow ${workflowId}`,
          );
        }
        const serviceUrl = workflowDefinition.serviceUrl;
        if (!serviceUrl) {
          throw new Error(
            `Service URL is not defined for workflow ${workflowId}`,
          );
        }

        const definition =
          await services.orchestratorService.fetchWorkflowDefinition({
            definitionId: workflowId,
            cacheHandler: 'throw',
          });

        if (!definition) {
          throw new Error(
            'Failed to fetch workflow definition for workflow ${workflowId}',
          );
        }

        if (!definition.dataInputSchema) {
          res.status(200).json({});
          return;
        }

        const instanceVariables = instanceId
          ? await services.orchestratorService.fetchInstanceVariables({
              instanceId,
              cacheHandler: 'throw',
            })
          : undefined;

        const workflowData = instanceVariables
          ? services.dataInputSchemaService.extractWorkflowData(
              instanceVariables,
            )
          : undefined;

        const workflowInfo = await routerApi.v2
          .getWorkflowInputSchemaById(workflowId, serviceUrl)
          .catch((error: { message: string }) => {
            auditLogRequestError(error, endpointName, endpoint, req);
            res.status(500).json({
              message: error.message || INTERNAL_SERVER_ERROR_MESSAGE,
            });
          });

        if (
          !workflowInfo ||
          !workflowInfo.inputSchema ||
          !workflowInfo.inputSchema.properties
        ) {
          res.status(200).json({});
          return;
        }

        const inputSchemaProps = workflowInfo.inputSchema.properties;
        let inputData;

        if (workflowData) {
          inputData = Object.keys(inputSchemaProps)
            .filter(k => k in workflowData)
            .reduce((result, k) => {
              if (!workflowData[k]) {
                return result;
              }
              result[k] = workflowData[k];
              return result;
            }, {} as JsonObject);
        }

        res.status(200).json({
          inputSchema: workflowInfo.inputSchema,
          data: inputData,
        });
      } catch (err) {
        auditLogRequestError(err, endpointName, endpoint, req);
        next(err);
      }
    },
  );

  // v2
  routerApi.openApiBackend.register(
    'getWorkflowInstances',
    async (c, req: express.Request, res: express.Response, next) => {
      const endpointName = 'getWorkflowInstances';
      const workflowId = c.request.params.workflowId as string;
      const endpoint = `/v2/workflows/${workflowId}/instances`;

      auditLogger.auditLog({
        eventName: endpointName,
        stage: 'start',
        status: 'succeeded',
        level: 'debug',
        request: req,
        message: `Received request to '${endpoint}' endpoint`,
      });

      const decision = await authorize(
        req,
        [
          orchestratorWorkflowPermission,
          orchestratorWorkflowSpecificPermission(workflowId),
        ],
        permissions,
        httpAuth,
      );
      if (decision.result === AuthorizeResult.DENY) {
        manageDenyAuthorization(endpointName, endpoint, req);
      }
      return routerApi.v2
        .getInstances(buildPagination(req), getRequestFilters(req), [
          workflowId,
        ])
        .then(result => res.json(result))
        .catch(error => {
          auditLogRequestError(error, endpointName, endpoint, req);
          next(error);
        });
    },
  );

  // v2
  routerApi.openApiBackend.register(
    'getInstances',
    async (_c, req: express.Request, res: express.Response, next) => {
      const endpointName = 'getInstances';
      const endpoint = `/v2/workflows/instances`;

      auditLogger.auditLog({
        eventName: endpointName,
        stage: 'start',
        status: 'succeeded',
        level: 'debug',
        request: req,
        message: `Received request to '${endpoint}' endpoint`,
      });

      try {
        // Once we assign user to the instance in the future, we can rework this filtering
        const allWorkflowIds = routerApi.v2.getWorkflowIds();
        const authorizedWorkflowIds: string[] =
          await filterAuthorizedWorkflowIds(
            req,
            permissions,
            httpAuth,
            allWorkflowIds,
          );

        const result = await routerApi.v2.getInstances(
          buildPagination(req),
          getRequestFilters(req),
          authorizedWorkflowIds,
        );

        res.json(result);
      } catch (error) {
        auditLogRequestError(error, endpointName, endpoint, req);
        next(error);
      }
    },
  );

  // v2
  routerApi.openApiBackend.register(
    'getInstanceById',
    async (c, _req: express.Request, res: express.Response, next) => {
      const instanceId = c.request.params.instanceId as string;
      const endpointName = 'getInstanceById';
      const endpoint = `/v2/workflows/instances/${instanceId}`;

      auditLogger.auditLog({
        eventName: endpointName,
        stage: 'start',
        status: 'succeeded',
        level: 'debug',
        request: _req,
        message: `Received request to '${endpoint}' endpoint`,
      });

      const includeAssessment = routerApi.v2.extractQueryParam(
        c.request,
        QUERY_PARAM_INCLUDE_ASSESSMENT,
      );

      try {
        const assessedInstance = await routerApi.v2.getInstanceById(
          instanceId,
          !!includeAssessment,
        );

        const workflowId = assessedInstance.instance.processId;

        const decision = await authorize(
          _req,
          [
            orchestratorWorkflowPermission,
            orchestratorWorkflowSpecificPermission(workflowId),
          ],
          permissions,
          httpAuth,
        );
        if (decision.result === AuthorizeResult.DENY) {
          manageDenyAuthorization(endpointName, endpoint, _req);
        }

        res.status(200).json(assessedInstance);
      } catch (error) {
        auditLogRequestError(error, endpointName, endpoint, _req);
        next(error);
      }
    },
  );

  // v2
  routerApi.openApiBackend.register(
    'abortWorkflow',
    async (c, _req, res, next) => {
      const instanceId = c.request.params.instanceId as string;
      const endpointName = 'abortWorkflow';
      const endpoint = `/v2/workflows/instances/${instanceId}/abort`;

      auditLogger.auditLog({
        eventName: endpointName,
        stage: 'start',
        status: 'succeeded',
        level: 'debug',
        request: _req,
        message: `Received request to '${endpoint}' endpoint`,
      });

      try {
        const assessedInstance = await routerApi.v2.getInstanceById(instanceId);
        const workflowId = assessedInstance.instance.processId;

        const decision = await authorize(
          _req,
          [
            orchestratorWorkflowUsePermission,
            orchestratorWorkflowUseSpecificPermission(workflowId),
          ],
          permissions,
          httpAuth,
        );
        if (decision.result === AuthorizeResult.DENY) {
          manageDenyAuthorization(endpointName, endpoint, _req);
        }

        const result = await routerApi.v2.abortWorkflow(workflowId, instanceId);
        res.status(200).json(result);
      } catch (error) {
        auditLogRequestError(error, endpointName, endpoint, _req);
        next(error);
      }
    },
  );
}

// ======================================================
// External SonataFlow API calls to delegate to Backstage
// ======================================================
function setupExternalRoutes(
  router: express.Router,
  discovery: DiscoveryApi,
  scaffolderService: ScaffolderService,
  auditLogger: AuditLogger,
) {
  router.get('/actions', async (req, res) => {
    auditLogger.auditLog({
      eventName: 'ActionsEndpointHit',
      stage: 'start',
      status: 'succeeded',
      level: 'debug',
      request: req,
      message: `Received request to '/actions' endpoint`,
    });
    const scaffolderUrl = await discovery.getBaseUrl('scaffolder');
    const response = await fetch(`${scaffolderUrl}/v2/actions`);
    const json = await response.json();
    res.status(response.status).json(json);
  });

  router.post('/actions/:actionId', async (req, res) => {
    const { actionId } = req.params;
    auditLogger.auditLog({
      eventName: 'ActionsActionIdEndpointHit',
      stage: 'start',
      status: 'succeeded',
      level: 'debug',
      request: req,
      message: `Received request to '/actions/${actionId}' endpoint`,
    });
    const instanceId: string | undefined = req.header('kogitoprocinstanceid');
    const body: JsonObject = (await req.body) as JsonObject;

    const filteredBody = Object.fromEntries(
      Object.entries(body).filter(
        ([, value]) => value !== undefined && value !== null,
      ),
    );

    const result: JsonValue = await scaffolderService.executeAction({
      actionId,
      instanceId,
      input: filteredBody,
    });
    res.status(200).json(result);
  });
}

function getRequestFilters(req: HttpRequest): Filter | undefined {
  return req.body.filters ? (req.body.filters as Filter) : undefined;
}
