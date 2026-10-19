import { cert, applicationDefault, getApps, initializeApp } from 'firebase-admin/app';
import { getMessaging } from 'firebase-admin/messaging';
import { env } from '../../config/env.js';

let app;
function firebaseApp() {
  if (!app) app = getApps().find((entry) => entry.name === 'm3allem-push') ?? initializeApp({
    credential: env.FCM_SERVICE_ACCOUNT_JSON ? cert(JSON.parse(env.FCM_SERVICE_ACCOUNT_JSON)) : applicationDefault(),
    ...(env.FCM_PROJECT_ID ? { projectId: env.FCM_PROJECT_ID } : {})
  }, 'm3allem-push');
  return app;
}
export const firebaseProvider = {
  // Check credentials before claiming work, so a missing deployment credential
  // does not consume every queued delivery's retry allowance.
  ready: () => firebaseApp().options.credential.getAccessToken(),
  send: (message) => getMessaging(firebaseApp()).send(message)
};
