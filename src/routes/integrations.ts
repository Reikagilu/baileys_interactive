import { Router, type Request, type Response } from 'express';
import { normalizeInstanceName } from '../utils/helpers.js';
import { sendError, sendOk } from '../utils/api-response.js';
import { writeAuditEvent } from '../services/audit-log.js';
import { config } from '../config.js';
import { validateOutboundUrl } from '../utils/url-security.js';
import {
  getInstanceIntegrations,
  listIntegrationInstances,
  testChatwoot,
  testN8n,
  updateChatwootConfig,
  updateN8nConfig,
} from '../services/integrations.js';

const router = Router();

function getInstanceParam(req: Request, res: Response): string | null {
  const instance = normalizeInstanceName(req.params.instance);
  if (!instance) {
    sendError(res, 400, 'invalid_instance_name');
    return null;
  }
  return instance;
}

router.get('/', (_req: Request, res: Response) => {
  return sendOk(res, { items: listIntegrationInstances() });
});

router.get('/:instance', (req: Request, res: Response) => {
  const instance = getInstanceParam(req, res);
  if (!instance) return;
  return sendOk(res, { integration: getInstanceIntegrations(instance) });
});

router.patch('/:instance/chatwoot', (req: Request, res: Response) => {
  const instance = getInstanceParam(req, res);
  if (!instance) return;

  const body = (req.body ?? {}) as {
    enabled?: boolean;
    baseUrl?: string;
    accountId?: string;
    inboxId?: string;
    apiAccessToken?: string;
  };

  const baseUrlRaw = body.baseUrl !== undefined ? String(body.baseUrl).trim() : undefined;
  let baseUrl = baseUrlRaw;
  if (baseUrlRaw) {
    const validation = validateOutboundUrl(baseUrlRaw, {
      allowPrivateNetwork: config.security.allowPrivateNetworkIntegrations,
    });
    if (!validation.ok) {
      return sendError(res, 400, 'invalid_chatwoot_base_url', 'Chatwoot base URL blocked by security policy.', {
        reason: validation.error,
        details: validation.details,
      });
    }
    baseUrl = validation.normalizedUrl;
  }

  const integration = updateChatwootConfig(instance, {
    enabled: typeof body.enabled === 'boolean' ? body.enabled : undefined,
    baseUrl,
    accountId: body.accountId !== undefined ? String(body.accountId).trim() : undefined,
    inboxId: body.inboxId !== undefined ? String(body.inboxId).trim() : undefined,
    apiAccessToken: body.apiAccessToken !== undefined ? String(body.apiAccessToken).trim() : undefined,
  });

  writeAuditEvent(req, res, {
    action: 'integrations.chatwoot.update',
    target: instance,
    details: {
      enabled: integration.chatwoot.enabled,
      hasToken: Boolean(integration.chatwoot.apiAccessToken),
    },
  });

  return sendOk(res, { integration });
});

router.patch('/:instance/n8n', (req: Request, res: Response) => {
  const instance = getInstanceParam(req, res);
  if (!instance) return;

  const body = (req.body ?? {}) as {
    enabled?: boolean;
    webhookUrl?: string;
    authHeaderName?: string;
    authHeaderValue?: string;
  };

  const webhookUrlRaw = body.webhookUrl !== undefined ? String(body.webhookUrl).trim() : undefined;
  let webhookUrl = webhookUrlRaw;
  if (webhookUrlRaw) {
    const validation = validateOutboundUrl(webhookUrlRaw, {
      allowPrivateNetwork: config.security.allowPrivateNetworkIntegrations,
    });
    if (!validation.ok) {
      return sendError(res, 400, 'invalid_n8n_webhook_url', 'n8n webhook URL blocked by security policy.', {
        reason: validation.error,
        details: validation.details,
      });
    }
    webhookUrl = validation.normalizedUrl;
  }

  const integration = updateN8nConfig(instance, {
    enabled: typeof body.enabled === 'boolean' ? body.enabled : undefined,
    webhookUrl,
    authHeaderName: body.authHeaderName !== undefined ? String(body.authHeaderName).trim() : undefined,
    authHeaderValue: body.authHeaderValue !== undefined ? String(body.authHeaderValue).trim() : undefined,
  });

  writeAuditEvent(req, res, {
    action: 'integrations.n8n.update',
    target: instance,
    details: {
      enabled: integration.n8n.enabled,
      hasAuthHeader: Boolean(integration.n8n.authHeaderName && integration.n8n.authHeaderValue),
    },
  });

  return sendOk(res, { integration });
});

router.post('/:instance/chatwoot/test', async (req: Request, res: Response) => {
  const instance = getInstanceParam(req, res);
  if (!instance) return;

  const result = await testChatwoot(instance);
  writeAuditEvent(req, res, {
    action: 'integrations.chatwoot.test',
    target: instance,
    outcome: result.ok ? 'success' : 'failure',
    details: { status: result.status ?? null, error: result.error ?? null },
  });

  if (!result.ok) {
    if (result.error === 'chatwoot_not_configured') {
      return sendError(res, 400, result.error);
    }
    if (result.error === 'chatwoot_url_blocked') {
      return sendError(res, 400, result.error, 'Chatwoot URL blocked by security policy.');
    }
    if (typeof result.status === 'number') {
      return sendError(res, 502, 'chatwoot_test_failed', result.error, { status: result.status });
    }
    return sendError(res, 502, 'chatwoot_test_failed', result.error);
  }

  return sendOk(res, { tested: true, status: result.status ?? 200 });
});

router.post('/:instance/n8n/test', async (req: Request, res: Response) => {
  const instance = getInstanceParam(req, res);
  if (!instance) return;

  const result = await testN8n(instance);
  writeAuditEvent(req, res, {
    action: 'integrations.n8n.test',
    target: instance,
    outcome: result.ok ? 'success' : 'failure',
    details: { status: result.status ?? null, error: result.error ?? null },
  });

  if (!result.ok) {
    if (result.error === 'n8n_not_configured') {
      return sendError(res, 400, result.error);
    }
    if (result.error === 'n8n_url_blocked') {
      return sendError(res, 400, result.error, 'n8n URL blocked by security policy.');
    }
    if (typeof result.status === 'number') {
      return sendError(res, 502, 'n8n_test_failed', result.error, { status: result.status });
    }
    return sendError(res, 502, 'n8n_test_failed', result.error);
  }

  return sendOk(res, { tested: true, status: result.status ?? 200 });
});

export default router;
