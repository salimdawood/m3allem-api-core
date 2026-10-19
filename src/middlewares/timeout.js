export const requestTimeout=(milliseconds)=> (req,res,next)=>{
  const timer=setTimeout(()=>{if(!res.headersSent)res.status(504).json({error:{code:'REQUEST_TIMEOUT',message:'The request timed out.'},requestId:req.id});},milliseconds);
  timer.unref?.();
  res.on('finish',()=>clearTimeout(timer));
  res.on('close',()=>clearTimeout(timer));
  next();
};
