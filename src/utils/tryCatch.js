export const tryCatch = (controller) => async (req, res, next) => {
  try {
    const result = await controller(req);
    if (res.headersSent) return;
    if (result?.headers) res.set(result.headers);
    if ([204, 304].includes(result?.statusCode)) return res.status(result.statusCode).end();
    return res.status(result?.statusCode ?? 200).json(result?.data ?? result);
  } catch (error) {
    return next(error);
  }
};
