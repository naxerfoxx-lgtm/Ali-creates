
require("dotenv").config();
const path = require("path");
const crypto = require("crypto");
const express = require("express");
const helmet = require("helmet");
const session = require("express-session");
const PgSession = require("connect-pg-simple")(session);
const { Pool } = require("pg");
const bcrypt = require("bcryptjs");
const rateLimit = require("express-rate-limit");
const multer = require("multer");
const cloudinary = require("cloudinary").v2;

const app = express();
const isProd = process.env.NODE_ENV === "production";
const port = Number(process.env.PORT || 3000);
const maxVideoMb = Math.max(5, Math.min(Number(process.env.MAX_VIDEO_MB || 100), 500));
const hasDb = Boolean(process.env.DATABASE_URL);
const hasCloudinary = Boolean(process.env.CLOUDINARY_CLOUD_NAME && process.env.CLOUDINARY_API_KEY && process.env.CLOUDINARY_API_SECRET);

if (!process.env.SESSION_SECRET || process.env.SESSION_SECRET.length < 32) {
  console.warn("WARNING: SESSION_SECRET should be a random string of at least 32 characters.");
}
if (!process.env.ADMIN_EMAIL || !process.env.ADMIN_PASSWORD) {
  console.warn("WARNING: Set ADMIN_EMAIL and ADMIN_PASSWORD to provision the admin account.");
}
if (!hasDb) console.warn("WARNING: DATABASE_URL missing. Server will not start until PostgreSQL is configured.");

const pool = hasDb ? new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.PGSSL === "true" ? { rejectUnauthorized: false } : undefined,
  max: 10,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 10000
}) : null;

if (hasCloudinary) cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
  secure: true
});

app.disable("x-powered-by");
if (isProd) app.set("trust proxy", 1);
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
      fontSrc: ["'self'", "https://fonts.gstatic.com", "data:"],
      imgSrc: ["'self'", "data:", "https://res.cloudinary.com", "https:"],
      mediaSrc: ["'self'", "https://res.cloudinary.com", "https:"],
      frameSrc: ["'self'", "https://www.youtube-nocookie.com", "https://www.youtube.com"],
      connectSrc: ["'self'", "https://api.cloudinary.com"],
      objectSrc: ["'none'"],
      upgradeInsecureRequests: isProd ? [] : null
    }
  }
}));
app.use(express.json({ limit: "1mb" }));
app.use(express.urlencoded({ extended: false, limit: "1mb" }));
app.use(express.static(path.join(__dirname, "Public"), { maxAge: isProd ? "1h" : 0 }));

const sessionSecret = process.env.SESSION_SECRET || crypto.randomBytes(48).toString("hex");
if (pool) {
  app.use(session({
    store: new PgSession({ pool, tableName: "user_sessions", createTableIfMissing: true }),
    secret: sessionSecret,
    resave: false,
    saveUninitialized: false,
    cookie: { httpOnly: true, secure: isProd, sameSite: "lax", maxAge: 1000 * 60 * 60 * 8 },
    name: "alicreates.sid"
  }));
} else {
  app.use(session({
    secret: sessionSecret, resave: false, saveUninitialized: false,
    cookie: { httpOnly: true, secure: isProd, sameSite: "lax", maxAge: 1000 * 60 * 60 * 8 }
  }));
}

const loginLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 8, standardHeaders: "draft-7", legacyHeaders: false, message: { error: "Too many login attempts. Wait 15 minutes and try again." } });
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: maxVideoMb * 1024 * 1024, files: 1 },
  fileFilter: (req, file, cb) => {
    const okMime = ["video/mp4", "video/webm", "video/quicktime", "video/x-m4v"].includes(file.mimetype);
    const okExt = /\.(mp4|webm|mov|m4v)$/i.test(file.originalname || "");
    cb(okMime && okExt ? null : new Error("Upload an MP4, WebM, MOV or M4V video file."), okMime && okExt);
  }
});

async function initDb() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS admins (
      id SERIAL PRIMARY KEY, email TEXT UNIQUE NOT NULL, password_hash TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS videos (
      id SERIAL PRIMARY KEY, title VARCHAR(120) NOT NULL, category VARCHAR(40) NOT NULL DEFAULT 'Other',
      description VARCHAR(500) NOT NULL DEFAULT '', video_url TEXT NOT NULL, poster_url TEXT NOT NULL DEFAULT '',
      public_id TEXT NOT NULL DEFAULT '', video_type VARCHAR(20) NOT NULL DEFAULT 'cloudinary',
      duration VARCHAR(30) NOT NULL DEFAULT '', featured BOOLEAN NOT NULL DEFAULT FALSE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS site_settings (
      key TEXT PRIMARY KEY, value TEXT NOT NULL DEFAULT ''
    );
  `);
  const email = String(process.env.ADMIN_EMAIL || "").trim().toLowerCase();
  const password = String(process.env.ADMIN_PASSWORD || "");
  if (email && password) {
    const existing = await pool.query("SELECT id FROM admins WHERE email=$1", [email]);
    if (!existing.rowCount) {
      const hash = await bcrypt.hash(password, 12);
      await pool.query("INSERT INTO admins(email,password_hash) VALUES($1,$2)", [email, hash]);
      console.log("Initial admin created from ADMIN_EMAIL.");
    }
  }
  const defaults = {
    site_name: process.env.SITE_NAME || "AliCreates",
    whatsapp: process.env.WHATSAPP_NUMBER || "",
    contact_email: process.env.CONTACT_EMAIL || "",
    instagram: process.env.INSTAGRAM_URL || "",
    tiktok: process.env.TIKTOK_URL || "",
    facebook: process.env.FACEBOOK_URL || "",
    x: process.env.X_URL || ""
  };
  for (const [key, value] of Object.entries(defaults)) {
    await pool.query("INSERT INTO site_settings(key,value) VALUES($1,$2) ON CONFLICT(key) DO NOTHING", [key, value]);
  }
}

let dbInitPromise = null;

async function ensureDbInitialized(req, res, next) {
  if (!pool || req.path === "/api/health") return next();
  try {
    if (!dbInitPromise) {
      dbInitPromise = initDb().catch(error => {
        dbInitPromise = null;
        throw error;
      });
    }
    await dbInitPromise;
    next();
  } catch (error) {
    next(error);
  }
}

app.use(ensureDbInitialized);

async function query(sql, params=[]) {
  if (!pool) throw new Error("Database is not configured. Set DATABASE_URL.");
  return pool.query(sql, params);
}
function requireAdmin(req,res,next) {
  if (!req.session || !req.session.adminId) return res.status(401).json({error:"Please sign in to the admin dashboard."});
  next();
}
function cleanText(value, max=500) { return String(value || "").trim().slice(0,max); }
function validUrl(value) {
  if (!value) return "";
  try { const u = new URL(value); return ["http:","https:"].includes(u.protocol) ? u.toString() : ""; } catch { return ""; }
}
async function getSettings() {
  const r = await query("SELECT key,value FROM site_settings");
  return Object.fromEntries(r.rows.map(x => [x.key, x.value]));
}

app.get("/api/health", async (req,res) => {
  try { if (pool) await pool.query("SELECT 1"); res.json({ok:true, database:Boolean(pool), mediaStorage:hasCloudinary ? "cloudinary" : "not-configured"}); }
  catch { res.status(503).json({ok:false}); }
});
app.get("/api/public", async (req,res,next) => {
  try {
    const [v,s] = await Promise.all([
      query("SELECT id,title,category,description,video_url,poster_url,video_type,duration,featured,created_at FROM videos ORDER BY featured DESC, created_at DESC"),
      getSettings()
    ]);
    res.json({site:{name:s.site_name || "AliCreates", whatsapp:s.whatsapp||"", email:s.contact_email||"", socials:{instagram:s.instagram||"",tiktok:s.tiktok||"",facebook:s.facebook||"",x:s.x||""}}, videos:v.rows});
  } catch(e) { next(e); }
});
app.post("/api/admin/login", loginLimiter, async (req,res,next) => {
  try {
    const email = cleanText(req.body.email, 254).toLowerCase();
    const password = String(req.body.password || "");
    const r = await query("SELECT id,email,password_hash FROM admins WHERE email=$1", [email]);
    if (!r.rowCount || !(await bcrypt.compare(password, r.rows[0].password_hash))) return res.status(401).json({error:"Email or password is incorrect."});
    await new Promise((resolve,reject)=>req.session.regenerate(err=>err?reject(err):resolve()));
    req.session.adminId = r.rows[0].id;
    req.session.adminEmail = r.rows[0].email;
    res.json({ok:true,email:r.rows[0].email});
  } catch(e) { next(e); }
});
app.post("/api/admin/logout", requireAdmin, (req,res) => req.session.destroy(()=>{res.clearCookie("alicreates.sid");res.json({ok:true})}));
app.get("/api/admin/me", (req,res) => res.json({authenticated:Boolean(req.session && req.session.adminId),email:req.session?.adminEmail||""}));
app.get("/api/admin/videos", requireAdmin, async (req,res,next) => {
  try { const r=await query("SELECT * FROM videos ORDER BY created_at DESC");res.json({videos:r.rows}); } catch(e){next(e)}
});
app.post("/api/admin/videos", requireAdmin, async (req,res,next) => {
  try {
    const title=cleanText(req.body.title,120), category=cleanText(req.body.category,40)||"Other", description=cleanText(req.body.description,500);
    const videoUrl=validUrl(req.body.video_url), posterUrl=validUrl(req.body.poster_url), duration=cleanText(req.body.duration,30);
    const videoType=["youtube","external","cloudinary"].includes(req.body.video_type)?req.body.video_type:"external";
    if(!title) return res.status(400).json({error:"Title is required."});
    if(!videoUrl) return res.status(400).json({error:"A valid video URL is required."});
    const r=await query("INSERT INTO videos(title,category,description,video_url,poster_url,video_type,duration,featured) VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *",[title,category,description,videoUrl,posterUrl,videoType,duration,Boolean(req.body.featured)]);
    res.status(201).json({video:r.rows[0]});
  } catch(e){next(e)}
});
app.put("/api/admin/videos/:id", requireAdmin, async (req,res,next) => {
  try {
    const id=Number(req.params.id), title=cleanText(req.body.title,120), category=cleanText(req.body.category,40)||"Other", description=cleanText(req.body.description,500);
    const videoUrl=validUrl(req.body.video_url), posterUrl=validUrl(req.body.poster_url), duration=cleanText(req.body.duration,30);
    const videoType=["youtube","external","cloudinary"].includes(req.body.video_type)?req.body.video_type:"external";
    if(!Number.isInteger(id)||id<1) return res.status(400).json({error:"Invalid video ID."});
    if(!title||!videoUrl) return res.status(400).json({error:"Title and a valid video URL are required."});
    const r=await query("UPDATE videos SET title=$1,category=$2,description=$3,video_url=$4,poster_url=$5,video_type=$6,duration=$7,featured=$8 WHERE id=$9 RETURNING *",[title,category,description,videoUrl,posterUrl,videoType,duration,Boolean(req.body.featured),id]);
    if(!r.rowCount)return res.status(404).json({error:"Video not found."});res.json({video:r.rows[0]});
  }catch(e){next(e)}
});
app.delete("/api/admin/videos/:id", requireAdmin, async(req,res,next)=>{
  try{
    const id=Number(req.params.id);if(!Number.isInteger(id)||id<1)return res.status(400).json({error:"Invalid video ID."});
    const r=await query("DELETE FROM videos WHERE id=$1 RETURNING public_id",[id]);
    if(!r.rowCount)return res.status(404).json({error:"Video not found."});
    if(hasCloudinary&&r.rows[0].public_id){cloudinary.uploader.destroy(r.rows[0].public_id,{resource_type:"video"}).catch(()=>{});}
    res.json({ok:true});
  }catch(e){next(e)}
});
app.post("/api/admin/upload", requireAdmin, (req,res,next)=>{
  if(!hasCloudinary)return res.status(503).json({error:"Video uploads require Cloudinary credentials. You can still add a public video URL in the dashboard."});
  upload.single("video")(req,res,async err=>{
    if(err)return res.status(400).json({error:err.message});
    if(!req.file)return res.status(400).json({error:"Choose a video file first."});
    try{
      const result=await new Promise((resolve,reject)=>{
        const stream=cloudinary.uploader.upload_stream({resource_type:"video",folder:"alicreates/portfolio",chunk_size:6*1024*1024},(error,out)=>error?reject(error):resolve(out));
        stream.end(req.file.buffer);
      });
      res.status(201).json({url:result.secure_url,public_id:result.public_id,duration:result.duration?`${Math.round(result.duration)} sec`:"",format:result.format});
    }catch(e){console.error("Cloudinary upload failed",e.message);res.status(502).json({error:"Video upload failed. Check Cloudinary setup, file size and account limits."})}
  });
});
app.get("/api/admin/settings",requireAdmin,async(req,res,next)=>{try{res.json({settings:await getSettings()})}catch(e){next(e)}});
app.put("/api/admin/settings",requireAdmin,async(req,res,next)=>{
  try{
    const allowed=["site_name","whatsapp","contact_email","instagram","tiktok","facebook","x"];
    for(const key of allowed){
      if(req.body[key]===undefined)continue;
      let val=cleanText(req.body[key],key==="site_name"?80:500);
      if(["instagram","tiktok","facebook","x"].includes(key)&&val) {const safe=validUrl(val);if(!safe)return res.status(400).json({error:`Invalid URL for ${key}.`});val=safe;}
      if(key==="contact_email"&&val&&!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(val))return res.status(400).json({error:"Invalid contact email."});
      await query("INSERT INTO site_settings(key,value) VALUES($1,$2) ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value",[key,val]);
    }
    res.json({ok:true,settings:await getSettings()});
  }catch(e){next(e)}
});
app.post("/api/admin/change-password",requireAdmin,async(req,res,next)=>{
  try{
    const current=String(req.body.current_password||""), nextPassword=String(req.body.new_password||"");
    if(nextPassword.length<12)return res.status(400).json({error:"New password must be at least 12 characters."});
    const r=await query("SELECT password_hash FROM admins WHERE id=$1",[req.session.adminId]);
    if(!r.rowCount||!(await bcrypt.compare(current,r.rows[0].password_hash)))return res.status(401).json({error:"Current password is incorrect."});
    const hash=await bcrypt.hash(nextPassword,12);await query("UPDATE admins SET password_hash=$1 WHERE id=$2",[hash,req.session.adminId]);res.json({ok:true});
  }catch(e){next(e)}
});

app.get("/admin", (req,res)=>res.sendFile(path.join(__dirname,"Public","admin.html")));
app.get("*", (req,res,next) => {
  if(req.path.startsWith("/api/"))return res.status(404).json({error:"API endpoint not found."});
  res.sendFile(path.join(__dirname,"Public","index.html"),err=>{if(err)next(err)});
});
app.use((err,req,res,next)=>{
  console.error(err.stack || err);
  if(res.headersSent)return next(err);
  const status=err.status||500;
  res.status(status).json({error:isProd&&status===500?"Something went wrong. Please try again.":err.message||"Server error."});
});

async function start(){
  if(!pool){console.error("Cannot start: configure DATABASE_URL in .env");process.exit(1);}
  if (!dbInitPromise) dbInitPromise = initDb();
  await dbInitPromise;
  const server=app.listen(port,()=>console.log(`AliCreates running on port ${port}`));
  const shutdown=()=>server.close(()=>{pool.end().finally(()=>process.exit(0))});
  process.on("SIGTERM",shutdown);process.on("SIGINT",shutdown);
}

module.exports = app;

if (require.main === module) {
  start().catch(e=>{console.error("Startup failed:",e);process.exit(1)});
}
