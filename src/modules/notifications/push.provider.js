import { randomUUID } from 'node:crypto';
import { env } from '../../config/env.js';
import { logger } from '../../config/logger.js';
import { firebaseProvider } from './firebase.provider.js';

export const pushProvider = env.DELIVERY_MODE === 'mock' ? {
  async ready() {},
  async send() {
    const id = `mock:${randomUUID()}`;
    logger.info({ deliveryMode: 'mock', providerMessageId: id }, 'Mock push delivery accepted');
    return id;
  }
} : firebaseProvider;
