'use strict';
const express = require('express');
const crypto = require('crypto');
const router = express.Router();
const COOKIE_NAME = 'creator_session';
const SESSION_SECONDS = 8 * 60 * 60;
const attempts = new Map();
function parseCookies(header) { return String(header || '').split(';').reduce((acc, part) => { const i=part.indexOf('='); if(i>0) acc[part.slice(0,i).trim()]=decodeURIComponent(part.slice(i+1).trim()); return acc; }, {}); }
function readSession(req) {
 const secret=process.env.CREATOR_AUTH_SECRET||''; if(secret.length<32)return null;
 const parts=(parseCookies(req.headers.cookie)[COOKIE_NAME]||'').split('.'); if(parts.length!==2)return null;
 const expected=crypto.createHmac('sha256',secret).update(parts[0]).digest(); let supplied;
 try{supplied=Buffer.from(parts[1],'base64url');}catch(_){return null;}
 if(expected.length!==supplied.length||!crypto.timingSafeEqual(expected,supplied))return null;
 try{const p=JSON.parse(Buffer.from(parts[0],'base64url').toString('utf8'));return p.role==='creator'&&p.exp>=Math.floor(Date.now()/1000)?p:null;}catch(_){return null;}
}
function requireCreator(req,res,next){if(!readSession(req)){if(req.path&&req.path.endsWith('.html'))return res.redirect(302,'/creator-login.html');return res.status(401).json({success:false,error:'Acesso administrativo não autorizado.'});}next();}
function verifyPassword(password){
 const [saltHex,hashHex]=String(process.env.CREATOR_PASSWORD_HASH||'').split(':');
 if(!/^[a-f0-9]{32}$/i.test(saltHex||'')||!/^[a-f0-9]{128}$/i.test(hashHex||''))return false;
 const expected=Buffer.from(hashHex,'hex');const actual=crypto.scryptSync(password,Buffer.from(saltHex,'hex'),expected.length);return crypto.timingSafeEqual(expected,actual);
}
router.post('/login',(req,res)=>{
 res.set('Cache-Control','no-store');const email=String(req.body?.email||'').trim().toLowerCase();const password=String(req.body?.password||'');const configured=String(process.env.CREATOR_EMAIL||'').trim().toLowerCase();const ip=String(req.ip||req.socket?.remoteAddress||'unknown');const now=Date.now();const rec=attempts.get(ip)||{count:0,until:0};
 if(rec.until>now&&rec.count>=8)return res.status(429).json({success:false,error:'Muitas tentativas. Aguarde 15 minutos.'});
 if(rec.until<=now){rec.count=0;rec.until=now+900000;}
 if(!configured||!process.env.CREATOR_AUTH_SECRET||process.env.CREATOR_AUTH_SECRET.length<32||email!==configured||!verifyPassword(password)){rec.count++;attempts.set(ip,rec);return res.status(401).json({success:false,error:'E-mail ou senha incorretos.'});}
 attempts.delete(ip);const body=Buffer.from(JSON.stringify({role:'creator',sub:configured,exp:Math.floor(now/1000)+SESSION_SECONDS})).toString('base64url');const sig=crypto.createHmac('sha256',process.env.CREATOR_AUTH_SECRET).update(body).digest('base64url');
 res.cookie(COOKIE_NAME,body+'.'+sig,{httpOnly:true,secure:process.env.NODE_ENV==='production'||Boolean(process.env.RENDER),sameSite:'strict',path:'/',maxAge:SESSION_SECONDS*1000});return res.json({success:true});
});
router.get('/session',requireCreator,(req,res)=>{res.set('Cache-Control','no-store');res.json({success:true});});
router.post('/logout',(req,res)=>{res.clearCookie(COOKIE_NAME,{httpOnly:true,secure:process.env.NODE_ENV==='production'||Boolean(process.env.RENDER),sameSite:'strict',path:'/'});res.json({success:true});});
module.exports={router,requireCreator};
