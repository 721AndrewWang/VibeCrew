// The channels' routes (ADR 103): a project's Router-notification webhook, and a dry run of a
// channel profile on a text (the project page's preview, and tests).

import type { Router } from 'express';
import { z } from 'zod';
import { body } from '../schemas';
import { ASYNC_PROFILES, type AsyncProfileId, asyncRefusal, chatRefusal, reportGist, shapeAsync, webhookText } from './profiles';
import { deleteWebhook, saveWebhook, testWebhook, webhookInfo } from './webhook';

const KIND = z.enum(['decision', 'question', 'acceptance']);

const WebhookPut = z.object({
  url: z.string().max(2000).optional(),
  format: z.enum(['slack', 'feishu']).optional(),
  enabled: z.boolean().optional(),
  kinds: z.array(KIND).max(3).optional(),
});

const ProfileCheck = z.object({
  profile: z.enum(['chat', 'pull-request', 'issue', 'release-notes', 'comment', 'message']),
  text: z.string().max(60_000),
  kind: KIND.optional(),
});

export function channelRoutes(r: Router) {
  r.get('/projects/:id/webhook', (req, res) => res.json(webhookInfo(req.params.id)));
  r.put('/projects/:id/webhook', (req, res) => res.json(saveWebhook(req.params.id, body(WebhookPut, req.body))));
  r.delete('/projects/:id/webhook', (req, res) => res.json(deleteWebhook(req.params.id)));
  r.post('/projects/:id/webhook/test', async (req, res) => res.json({ delivery: await testWebhook(req.params.id) }));
  r.post('/channels/check', (req, res) => {
    const b = body(ProfileCheck, req.body);
    if (b.profile === 'chat') {
      res.json({ refusal: chatRefusal(b.text, b.kind), gist: reportGist(b.text), webhook: webhookText(b.text) });
      return;
    }
    const id = b.profile as AsyncProfileId;
    const refusal = asyncRefusal(id, b.text);
    res.json({ refusal, shaped: refusal ? undefined : shapeAsync(id, b.text), maxWords: ASYNC_PROFILES[id].maxWords });
  });
}
