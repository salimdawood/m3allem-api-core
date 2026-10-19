import multer from 'multer';
import { AppError } from '../../utils/AppError.js';

export const uploadFile=(maxBytes)=>{
  const parse=multer({storage:multer.memoryStorage(),limits:{files:1,fileSize:maxBytes,fields:0},fileFilter:(_req,file,cb)=>{
    if(!['image/jpeg','image/png','image/webp','application/pdf'].includes(file.mimetype))return cb(new AppError('UNSUPPORTED_MEDIA_TYPE',415));
    cb(null,true);
  }}).single('file');
  return(req,res,next)=>parse(req,res,(error)=>{
    if(error)return next(error instanceof AppError||error.name==='MulterError'?error:new AppError('INVALID_REQUEST',400));
    if(!req.file)return next(new AppError('DOCUMENT_REQUIRED',400));
    next();
  });
};
