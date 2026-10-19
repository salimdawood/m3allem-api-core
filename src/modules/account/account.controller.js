import { accountService } from './account.service.js';
import { authService } from '../auth/auth.service.js';

export const accountController = {
  deleteAccount: (req) => accountService.deleteAccount(req.user.id),
  setAccountStatus: (req) => accountService.setAccountStatus(req.user.id, req.validated.params.id, req.validated.body),
  getMe: (req) => authService.me(req.user.id),
  updateProfile: (req) => accountService.updateProfile(req.user.id, req.validated.body),
  getPublicUser: (req) => accountService.getPublicUser(req.validated.params.id),
  getSettings: (req) => accountService.getSettings(req.user.id),
  setSettings: (req) => accountService.setSettings(req.user.id, req.validated.body),
  getFavorites: (req) => accountService.getFavorites(req.user.id),
  addFavorite: (req) => accountService.addFavorite(req.user.id, req.validated.params.workerId),
  removeFavorite: (req) => accountService.removeFavorite(req.user.id, req.validated.params.workerId),
  favoriteWorkers: (req) => accountService.favoriteWorkers(req.user.id),
  notifications: (req) => accountService.notifications(req.user.id),
  readNotification: (req) => accountService.readNotification(req.user.id, req.validated.params.id),
  readAllNotifications: (req) => accountService.readAllNotifications(req.user.id),
  upsertDevice: (req) => accountService.upsertDevice(req.user.id, req.validated.body),
  removeDevice: (req) => accountService.removeDevice(req.user.id, req.validated.params.fcmToken),
  contactHistory: (req) => accountService.contactHistory(req.user.id),
  addContactHistory: (req) => accountService.addContactHistory(req.user.id, req.validated.body)
};
