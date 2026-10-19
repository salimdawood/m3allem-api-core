import { idNumber } from '../../utils/id.js';

export const userDto = (user) => ({
  id: idNumber(user.id), phoneNumber: user.phoneNumber, fullName: user.fullName,
  profileImageUploadId: user.profileImageUploadId == null ? null : idNumber(user.profileImageUploadId),
  location: user.latitude == null ? null : { latitude: user.latitude, longitude: user.longitude, address: user.address },
  isAdmin: user.isAdmin, isWorker: Boolean(user.workerProfiles && !user.workerProfiles.deletedAt),
  accountStatus: user.accountStatus, createdAt: new Date(user.createdAt).getTime(),
  recoveryEmail: user.recoveryEmail ?? null, nationality: user.nationality ?? null
});
