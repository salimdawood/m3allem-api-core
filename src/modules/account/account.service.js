import { AppError } from '../../utils/AppError.js';
import { authRepository } from '../auth/auth.repository.js';
import { userDto } from '../auth/user.dto.js';
import { accountRepository as repo } from './account.repository.js';
import { realtimeHub } from '../realtime/hub.js';
import { idNumber } from '../../utils/id.js';
import { workerService } from '../workers/worker.service.js';

const favoriteState = async (userId) => ({ workerIds: (await repo.favorites(userId)).map((row) => idNumber(row.id)) });
export const accountService = {
  async updateProfile(userId, input) {
    const data = {};
    if (input.fullName !== undefined) data.fullName = input.fullName.trim();
    if (input.profileImageUploadId !== undefined) {
      if (input.profileImageUploadId !== null && !await repo.avatarOwned(userId, input.profileImageUploadId))
        throw new AppError('INVALID_REQUEST', 400);
      data.profileImageUploadId = input.profileImageUploadId;
    }
    if (input.nationality !== undefined) data.nationality = input.nationality?.toUpperCase() ?? null;
    if (input.location !== undefined) Object.assign(data, input.location ? {
      latitude: input.location.latitude, longitude: input.location.longitude, address: input.location.address ?? null
    } : { latitude: null, longitude: null, address: null });
    return userDto(await authRepository.updateUser(userId, data));
  },
  async getPublicUser(id) {
    const user = await repo.publicUser(id);
    if (!user) throw new AppError('NOT_FOUND', 404);
    return { ...user, id: idNumber(user.id),
      profileImageUploadId: user.profileImageUploadId == null ? null : idNumber(user.profileImageUploadId) };
  },
  getSettings: async (userId) => (await repo.settings(userId))[0] ?? {
    notificationsEnabled: true, reminderLeadMinutes: 60, language: 'en'
  },
  setSettings: async (userId, input) => { await repo.upsertSettings(userId, input); return { statusCode: 204 }; },
  getFavorites: favoriteState,
  async addFavorite(userId, workerId) {
    if (!await repo.addFavorite(userId, workerId)) throw new AppError('NOT_FOUND', 404);
    realtimeHub.publish(userId, 'favorites.updated', await favoriteState(userId));
    return { statusCode: 204 };
  },
  async removeFavorite(userId, workerId) {
    await repo.removeFavorite(userId, workerId);
    realtimeHub.publish(userId, 'favorites.updated', await favoriteState(userId));
    return { statusCode: 204 };
  },
  favoriteWorkers: async (userId) => (await workerService.search({ favoritesOnly: true, sort: 'RATING', limit: 200 }, userId)).items,
  notifications: (userId) => repo.notifications(userId),
  readNotification: async (userId, id) => { await repo.readNotification(userId, id); return { statusCode: 204 }; },
  readAllNotifications: async (userId) => { await repo.readAllNotifications(userId); return { statusCode: 204 }; },
  upsertDevice: async (userId, input) => { await repo.upsertDevice(userId, input); return { statusCode: 204 }; },
  removeDevice: async (userId, token) => { await repo.removeDevice(userId, token); return { statusCode: 204 }; },
  contactHistory: (userId) => repo.contactHistory(userId),
  async addContactHistory(userId, input) {
    if (!await repo.addContactHistory(userId, input.workerId, input.interactionType)) throw new AppError('NOT_FOUND', 404);
    return { statusCode: 201, data: { accepted: true } };
  },
  async deleteAccount(userId) {
    await repo.softDelete(userId);
    realtimeHub.disconnect(userId);
    return { statusCode: 204 };
  },
  async setAccountStatus(actorId, userId, input) {
    if (actorId === userId) throw new AppError('FORBIDDEN', 403);
    if (!await repo.setAccountStatus(actorId, userId, input)) throw new AppError('NOT_FOUND', 404);
    realtimeHub.disconnect(userId);
    return { statusCode: 204 };
  }
};
