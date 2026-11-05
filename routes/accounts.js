const express = require('express');
const crypto = require('crypto');
const { query } = require('../database');
const { encryptSecret } = require('./merchant');
const router = express.Router();
const SECRET = process.env.ACCOUNT_AUTH_SECRET || process.env.MERCHANT_AUTH_SECRET || '';

function digits(v) { return String(v || '').replace(/\D/g, ''); }
function validCPF(v) {
  const c = digits(v); if (c.length !== 11 || /^(\d)\1{10}$/.test(c)) return false;
  let s = 0; for (let i=0;i<9;i++) s += Number(c[i])*(10-i);
  let d=(s*10)%11; if(d===10)d=0; if(d!==Number(c[9]))return false;
  s=0; for(let i=0;i<10;i++)s+=Number(c[i])*(11-i);
  d=(s*10)%11; if(d===10)d=0; return d===Number(c[10]);
}
function hashPassword(p) { const salt=crypto.randomBytes(16); return 'scrypt$'+salt.toString('hex')+'$'+crypto.scryptSync(p,salt,64).toString('hex'); }
function verifyPassword(p,stored) {
  try { const [kind,salt,hash]=String(stored||'').split('$'); if(kind!=='scrypt')return false;
    const expected=Buffer.from(hash,'hex'), actual=crypto.scryptSync(p,Buffer.from(salt,'hex'),expected.length);
    return expected.length===actual.length && crypto.timingSafeEqual(expected,actual);
  } catch (_) { return false; }
}
function issueToken(type,id) {
  if(!SECRET) throw new Error('Configure ACCOUNT_AUTH_SECRET no servidor.');
  const h=Buffer.from(JSON.stringify({alg:'HS256',typ:'JWT'})).toString('base64url');
  const p=Buffer.from(JSON.stringify({sub:String(id),typ:type,exp:Math.floor(Date.now()/1000)+1209600})).toString('base64url');
  const body=h+'.'+p; return body+'.'+crypto.createHmac('sha256',SECRET).update(body).digest('base64url');
}
function auth(type) {
 return (req,res,next)=>{ try {
  const parts=String(req.headers.authorization||'').replace(/^Bearer\s+/i,'').split('.');
  if(parts.length!==3||!SECRET)return res.status(401).json({success:false,error:'Sessão inválida.'});
  const sig=crypto.createHmac('sha256',SECRET).update(parts[0]+'.'+parts[1]).digest();
  const supplied=Buffer.from(parts[2],'base64url');
  if(sig.length!==supplied.length||!crypto.timingSafeEqual(sig,supplied))return res.status(401).json({success:false,error:'Sessão inválida.'});
  const p=JSON.parse(Buffer.from(parts[1],'base64url').toString());
  if(p.typ!==type||!p.sub||p.exp<Math.floor(Date.now()/1000))return res.status(401).json({success:false,error:'Sessão expirada.'});
  req.accountId=Number(p.sub); next();
 } catch(_){res.status(401).json({success:false,error:'Sessão inválida.'});} };
}
router.post('/customer/register',async(req,res)=>{
 try {
  const name=String(req.body?.name||'').trim(), cpf=digits(req.body?.cpf), phone=String(req.body?.phone||'').trim();
  if(!name||!validCPF(cpf)||!phone)return res.status(400).json({success:false,error:'Informe nome, CPF válido e telefone.'});
  const hash=crypto.createHash('sha256').update(cpf).digest('hex');
  const r=await query(`INSERT INTO customers(name,cpf_hash,cpf_encrypted,phone,last_table,visit_count)
   VALUES($1,$2,$3,$4,$5,1) ON CONFLICT(cpf_hash) DO UPDATE SET name=EXCLUDED.name,phone=EXCLUDED.phone,
   last_table=COALESCE(EXCLUDED.last_table,customers.last_table),visit_count=customers.visit_count+1,updated_at=NOW()
   RETURNING id,name,phone,last_table,visit_count`,
   [name,hash,encryptSecret(cpf),phone,req.body?.tableNumber==null?null:String(req.body.tableNumber)]);
  res.status(201).json({success:true,customer:r.rows[0],token:issueToken('customer',r.rows[0].id)});
 } catch(e){console.error('[CUSTOMER REGISTER]',e);res.status(500).json({success:false,error:'Não foi possível concluir o cadastro do cliente.'});}
});
router.post('/motoboy/register',async(req,res)=>{
 try {
  const b=req.body||{}, name=String(b.name||'').trim(),email=String(b.email||'').trim().toLowerCase(),
   phone=String(b.phone||'').trim(),cpf=digits(b.cpf),password=String(b.password||''),
   pixKey=String(b.pixKey||'').trim(),pixKeyType=String(b.pixKeyType||'').toUpperCase();
  if(!name||!email||!phone||!validCPF(cpf)||password.length<8||!pixKey)
   return res.status(400).json({success:false,error:'Preencha nome, e-mail, telefone, CPF válido, senha de 8 caracteres e chave Pix.'});
  if(!['CPF','CNPJ','EMAIL','PHONE','RANDOM'].includes(pixKeyType))return res.status(400).json({success:false,error:'Tipo de chave Pix inválido.'});
  const pixDigits=digits(pixKey);
  const validPix = pixKeyType==='CPF' ? validCPF(pixKey) :
    pixKeyType==='CNPJ' ? pixDigits.length===14 && !/^(\\d)\\1{13}$/.test(pixDigits) :
    pixKeyType==='EMAIL' ? /^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$/.test(pixKey) :
    pixKeyType==='PHONE' ? /^\\+55\\d{10,11}$/.test(pixKey) :
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(pixKey);
  if(!validPix)return res.status(400).json({success:false,error:'A chave Pix não corresponde ao tipo informado.'});
  const hash=crypto.createHash('sha256').update(cpf).digest('hex');
  const r=await query(`INSERT INTO motoboys(name,email,phone,cpf_hash,cpf_encrypted,password_hash,vehicle_data,cnh_data,pix_key_encrypted,pix_key_type,status)
   VALUES($1,$2,$3,$4,$5,$6,$7::jsonb,$8::jsonb,$9,$10,'pending')
   RETURNING id,name,email,phone,status,created_at`,
   [name,email,phone,hash,encryptSecret(cpf),hashPassword(password),JSON.stringify(b.vehicle||{}),JSON.stringify({number_encrypted:encryptSecret(String(b.cnh?.number||'')),category:String(b.cnh?.category||'')}),encryptSecret(pixKey),pixKeyType]);
  res.status(201).json({success:true,motoboy:r.rows[0],message:'Cadastro recebido e aguardando aprovação. Você poderá entrar depois que a administração aprovar sua conta.'});
 } catch(e){if(e.code==='23505')return res.status(409).json({success:false,error:'Este e-mail ou CPF já está cadastrado.'});
  console.error('[MOTOBOY REGISTER]',e);res.status(500).json({success:false,error:'Não foi possível concluir o cadastro do motoboy.'});}
});
router.post('/motoboy/login',async(req,res)=>{
 try {
  const email=String(req.body?.email||'').trim().toLowerCase();
  const r=await query('SELECT id,name,email,phone,password_hash,status FROM motoboys WHERE LOWER(email)=$1 LIMIT 1',[email]);
  const m=r.rows[0]; if(!m||!verifyPassword(String(req.body?.password||''),m.password_hash))return res.status(401).json({success:false,error:'E-mail ou senha incorretos.'});
  if(m.status!=='active')return res.status(403).json({success:false,error:m.status==='pending'?'Cadastro aguardando aprovação da administração.':'Cadastro bloqueado. Entre em contato com a administração.'});
  res.json({success:true,token:issueToken('motoboy',m.id),motoboy:{id:m.id,name:m.name,email:m.email,phone:m.phone,status:m.status}});
 }catch(e){console.error('[MOTOBOY LOGIN]',e);res.status(500).json({success:false,error:'Não foi possível entrar na conta.'});}
});
router.get('/motoboy/me',auth('motoboy'),async(req,res)=>{
 try {
  const r=await query('SELECT id,name,email,phone,status,vehicle_data,created_at FROM motoboys WHERE id=$1',[req.accountId]);
  if(!r.rows[0])return res.status(404).json({success:false,error:'Motoboy não encontrado.'});
  const b=await query(`SELECT COALESCE(SUM(amount_cents-paid_cents),0)::bigint AS pending_cents,
    MIN(due_at) FILTER(WHERE paid_cents<amount_cents) AS next_due_at FROM motoboy_deliveries WHERE motoboy_id=$1`,[req.accountId]);
  res.json({success:true,motoboy:r.rows[0],balance:b.rows[0]});
 }catch(e){console.error('[MOTOBOY PROFILE]',e);res.status(500).json({success:false,error:'Não foi possível consultar a conta.'});}
});
module.exports=router;
