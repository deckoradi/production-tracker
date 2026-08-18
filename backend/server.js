const express=require('express');
const cors=require('cors');
const multer=require('multer');
const XLSX=require('xlsx');
const fs=require('fs');
const path=require('path');
const bcrypt=require('bcryptjs');
const jwt=require('jsonwebtoken');
const nodemailer=require('nodemailer');
const ExcelJS=require('exceljs');
const {Pool}=require('pg');
require('dotenv').config({path:path.join(__dirname,'.env')});

const app=express();
const PORT=process.env.PORT||5001;
const PHASES=['100','200','300','400','500'];
const pool=new Pool({connectionString:process.env.DATABASE_URL,ssl:{rejectUnauthorized:false}});

app.use(cors({origin:true,credentials:true,methods:['GET','POST','PUT','DELETE','OPTIONS'],allowedHeaders:['Content-Type','Authorization']}));
app.use(express.json({limit:'50mb'}));
app.use(express.static(path.join(__dirname,'../frontend')));
app.get('/',(req,res)=>res.sendFile(path.join(__dirname,'../frontend/index.html')));

const uploadsDir=path.join(__dirname,'uploads');
if(!fs.existsSync(uploadsDir))fs.mkdirSync(uploadsDir,{recursive:true});
const upload=multer({storage:multer.diskStorage({destination:uploadsDir,filename:(req,f,cb)=>cb(null,Date.now()+'-'+f.originalname)}),limits:{fileSize:100*1024*1024},fileFilter:(req,f,cb)=>{const e=path.extname(f.originalname).toLowerCase();cb(e!=='.xlsx'&&e!=='.xls'?new Error('Only Excel files'):null,true)}});

function auth(req,res,next){const t=req.headers.authorization?.split(' ')[1];if(!t)return res.status(401).json({error:'No token'});try{req.user=jwt.verify(t,process.env.JWT_SECRET||'secret');next()}catch(e){res.status(401).json({error:'Invalid token'})}}
function admin(req,res,next){if(req.user.role!=='admin')return res.status(403).json({error:'Access denied'});next()}
function key(v){return String(v??'').trim().replace(/\s+/g,' ').toLowerCase()}
function val(row,keys){for(const k of keys)if(row[k]!==undefined&&row[k]!==null&&String(row[k]).trim()!=='')return row[k];return ''}
function qty(v){const n=Number(String(v??'').replace(/\s/g,'').replace(',','.'));return Number.isFinite(n)?Math.round(n):0}
function orderId(company,number){const crypto=require('crypto');const h=crypto.createHash('sha256').update(company+'|'+number).digest('hex');return Number(BigInt('0x'+h.slice(0,15))%9007199254740991n)+1}

async function initDb(){
 try{
  await pool.query(`CREATE TABLE IF NOT EXISTS users(id SERIAL PRIMARY KEY,username VARCHAR(100) UNIQUE NOT NULL,password VARCHAR(255) NOT NULL,role VARCHAR(50) DEFAULT 'user',company VARCHAR(255) NOT NULL,created_at TIMESTAMP DEFAULT NOW())`);
  await pool.query(`CREATE TABLE IF NOT EXISTS orders(id BIGINT PRIMARY KEY,company VARCHAR(255),code VARCHAR(100),name VARCHAR(255),order_number VARCHAR(100),quantity INTEGER DEFAULT 0,delivery_date VARCHAR(100),created_at TIMESTAMP DEFAULT NOW())`);
  await pool.query(`CREATE TABLE IF NOT EXISTS progress(id SERIAL PRIMARY KEY,order_id BIGINT NOT NULL,phase VARCHAR(10) NOT NULL,status VARCHAR(20) DEFAULT 'pending',comment TEXT DEFAULT '',updated_at TIMESTAMP DEFAULT NOW(),UNIQUE(order_id,phase))`);
  await pool.query(`ALTER TABLE progress ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP DEFAULT NOW()`);
  await pool.query(`CREATE TABLE IF NOT EXISTS progress_history(id BIGSERIAL PRIMARY KEY,company VARCHAR(255) NOT NULL,order_number VARCHAR(100) NOT NULL,phase VARCHAR(10) NOT NULL,status VARCHAR(20) NOT NULL,comment TEXT DEFAULT '',changed_at TIMESTAMP DEFAULT NOW())`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_ph ON progress_history(company,order_number,phase,changed_at DESC)`);
  const a=await pool.query('SELECT id FROM users WHERE username=$1',['admin']);
  if(!a.rows.length){const p=await bcrypt.hash('admin123',10);await pool.query('INSERT INTO users(username,password,role,company) VALUES($1,$2,$3,$4)',['admin',p,'admin','Administrator'])}
  console.log('PostgreSQL: OK');
 }catch(e){console.error('DB init:',e)}
}
initDb();

app.post('/api/login',async(req,res)=>{try{const r=await pool.query('SELECT * FROM users WHERE username=$1',[req.body.username]);const u=r.rows[0];if(!u||!await bcrypt.compare(req.body.password,u.password))return res.status(401).json({error:'Invalid credentials'});const token=jwt.sign({id:u.id,username:u.username,role:u.role,company:u.company},process.env.JWT_SECRET||'secret',{expiresIn:'24h'});res.json({token,user:{id:u.id,username:u.username,role:u.role,company:u.company}})}catch(e){res.status(500).json({error:e.message})}});

app.get('/api/users',auth,admin,async(req,res)=>{try{res.json((await pool.query('SELECT id,username,role,company FROM users ORDER BY username')).rows)}catch(e){res.status(500).json({error:e.message})}});
app.post('/api/users',auth,admin,async(req,res)=>{try{const {username,company}=req.body;if((await pool.query('SELECT id FROM users WHERE username=$1',[username])).rows.length)return res.status(400).json({error:'Username already exists'});const p=await bcrypt.hash('password123',10);const r=await pool.query('INSERT INTO users(username,password,role,company) VALUES($1,$2,$3,$4) RETURNING id,username,role,company',[username,p,'user',company]);res.status(201).json({message:'User created',user:r.rows[0]})}catch(e){res.status(500).json({error:e.message})}});

app.post('/api/upload',auth,admin,upload.single('file'),async(req,res)=>{
 if(!req.file)return res.status(400).json({error:'Excel fajl nije poslat.'});
 const c=await pool.connect();
 try{
  const wb=XLSX.readFile(req.file.path,{cellDates:true,raw:false});const sh=wb.Sheets[wb.SheetNames[0]];const rows=XLSX.utils.sheet_to_json(sh,{defval:'',raw:false});
  if(!rows.length)throw new Error('Excel nema podataka.');
  const imported=[],seen=new Set();
  for(const row of rows){
   const company=String(val(row,['FIRMA','ime firme','IME FIRME','Firma','firma','Ime firme','Company','company','Naziv firme'])||req.user.company).trim();
   const code=String(val(row,['ŠIFRA','cod artikal','COD ARTIKAL','Sifra','sifra','Šifra artikla','Sifra artikla','Code','code'])).trim();
   const name=String(val(row,['NAZIV','naziv artikla','NAZIV ARTIKLA','Naziv','naziv','Naziv artikla','Name','name','Artikal','Proizvod'])).trim();
   const number=String(val(row,['NALOG','broj nalog','BROJ NALOG','Nalog','nalog','Broj naloga','BROJ NALOGA','Order','order','Order Number'])).trim();
   const quantity=qty(val(row,['KOLIČINA','pari','PARI','Kolicina','kolicina','QUANTITA','Quantity','quantity']));
   const delivery=String(val(row,['DATUM','datum isporuke','DATUM ISPORUKE','Datum','datum','Datum isporuke','Delivery Date','delivery'])).trim();
   if(!number)continue;const k=key(company)+'|'+key(number);if(seen.has(k))continue;seen.add(k);imported.push({company,code,name,number,quantity,delivery,key:k});
  }
  if(!imported.length)throw new Error('Nije pronađen nijedan validan nalog u Excel-u.');
  await c.query('BEGIN');
  const existing=(await c.query('SELECT id,company,order_number FROM orders')).rows;const map=new Map(existing.map(x=>[key(x.company)+'|'+key(x.order_number),x]));
  let inserted=0,updated=0,removed=0;
  for(const x of imported){
   const old=map.get(x.key);
   if(old){await c.query('UPDATE orders SET code=$1,name=$2,quantity=$3,delivery_date=$4 WHERE id=$5',[x.code,x.name,x.quantity,x.delivery,old.id]);updated++}
   else{
    const id=orderId(x.company,x.number);await c.query(`INSERT INTO orders(id,company,code,name,order_number,quantity,delivery_date) VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(id) DO UPDATE SET code=EXCLUDED.code,name=EXCLUDED.name,quantity=EXCLUDED.quantity,delivery_date=EXCLUDED.delivery`,[id,x.company,x.code,x.name,x.number,x.quantity,x.delivery]);
    for(const ph of PHASES){const h=(await c.query(`SELECT status,comment,changed_at FROM progress_history WHERE company=$1 AND order_number=$2 AND phase=$3 ORDER BY changed_at DESC,id DESC LIMIT 1`,[x.company,x.number,ph])).rows[0];await c.query(`INSERT INTO progress(order_id,phase,status,comment,updated_at) VALUES($1,$2,$3,$4,$5) ON CONFLICT(order_id,phase) DO NOTHING`,[id,ph,h?.status||'pending',h?.comment||'',h?.changed_at||new Date()])}
    inserted++;
   }
  }
  for(const x of (await c.query('SELECT id,company,order_number FROM orders')).rows){const k=key(x.company)+'|'+key(x.order_number);if(!seen.has(k)){await c.query('DELETE FROM progress WHERE order_id=$1',[x.id]);await c.query('DELETE FROM orders WHERE id=$1',[x.id]);removed++}}
  await c.query('COMMIT');try{fs.unlinkSync(req.file.path)}catch(_){ }
  res.json({message:'Excel uspešno sinhronizovan.',inserted,updated,removed,totalRows:rows.length,validOrders:imported.length});
 }catch(e){try{await c.query('ROLLBACK')}catch(_){}try{fs.unlinkSync(req.file.path)}catch(_){}console.error('upload:',e);res.status(500).json({error:e.message})}finally{c.release()}
});

app.get('/api/orders',auth,async(req,res)=>{try{
 const page=Math.max(1,parseInt(req.query.page)||1),limit=Math.min(500,Math.max(1,parseInt(req.query.limit)||100)),offset=(page-1)*limit;const p=[];let w='',i=1;
 if(req.user.role!=='admin'){w=`WHERE o.company=$${i}`;p.push(req.user.company);i++}
 if(req.query.search){const s='%'+String(req.query.search).toLowerCase()+'%';const q=`(LOWER(o.order_number) LIKE $${i} OR LOWER(o.name) LIKE $${i} OR LOWER(o.code) LIKE $${i} OR LOWER(o.company) LIKE $${i})`;w=w?`${w} AND ${q}`:`WHERE ${q}`;p.push(s);i++}
 const total=parseInt((await pool.query(`SELECT COUNT(*) FROM orders o ${w}`,p)).rows[0].count);
 const r=await pool.query(`SELECT o.*,COALESCE(json_agg(json_build_object('phase',p.phase,'status',p.status,'comment',p.comment,'updated_at',p.updated_at) ORDER BY p.phase) FILTER(WHERE p.phase IS NOT NULL),'[]') progress FROM orders o LEFT JOIN progress p ON o.id=p.order_id ${w} GROUP BY o.id ORDER BY o.id DESC LIMIT $${i} OFFSET $${i+1}`,[...p,limit,offset]);
 res.json({data:r.rows.map(o=>({id:o.id,company:o.company,code:o.code,name:o.name,orderNumber:o.order_number,quantity:o.quantity,deliveryDate:o.delivery_date,progress:(o.progress||[]).map(x=>({phase:x.phase,status:x.status,comment:x.comment||'',updatedAt:x.updated_at}))})),total,page,limit,totalPages:Math.max(1,Math.ceil(total/limit))});
}catch(e){console.error('orders:',e);res.status(500).json({error:e.message})}});

app.delete('/api/orders/clear',auth,admin,async(req,res)=>{const c=await pool.connect();try{await c.query('BEGIN');const n=parseInt((await c.query('SELECT COUNT(*) FROM orders')).rows[0].count);await c.query('DELETE FROM progress');await c.query('DELETE FROM orders');await c.query('COMMIT');res.json({deleted:n,message:'Aktivni nalozi obrisani. Istorija je sačuvana.'})}catch(e){await c.query('ROLLBACK');res.status(500).json({error:e.message})}finally{c.release()}});
app.delete('/api/orders/clear-all',auth,admin,async(req,res)=>{const c=await pool.connect();try{await c.query('BEGIN');const no=parseInt((await c.query('SELECT COUNT(*) FROM orders')).rows[0].count),nh=parseInt((await c.query('SELECT COUNT(*) FROM progress_history')).rows[0].count);await c.query('DELETE FROM progress');await c.query('DELETE FROM orders');await c.query('DELETE FROM progress_history');await c.query('COMMIT');res.json({deletedOrders:no,deletedHistory:nh})}catch(e){await c.query('ROLLBACK');res.status(500).json({error:e.message})}finally{c.release()}});

app.post('/api/update-phase',auth,async(req,res)=>{const c=await pool.connect();try{
 const {orderId,phase,status,comment}=req.body;if(!orderId||!PHASES.includes(String(phase)))return res.status(400).json({error:'Neispravan nalog ili faza.'});if(status!==undefined&&!['pending','completed','problem'].includes(status))return res.status(400).json({error:'Nepoznat status.'});
 await c.query('BEGIN');const or=(await c.query('SELECT company,order_number FROM orders WHERE id=$1',[orderId])).rows[0];if(!or)throw new Error('Nalog ne postoji.');if(req.user.role!=='admin'&&key(or.company)!==key(req.user.company)){await c.query('ROLLBACK');return res.status(403).json({error:'Nemate pristup ovom nalogu.'})}
 const old=(await c.query('SELECT status,comment FROM progress WHERE order_id=$1 AND phase=$2',[orderId,phase])).rows[0];const ns=status!==undefined?status:(old?.status||'pending');const nc=comment!==undefined?String(comment):(old?.comment||'');const now=new Date();
 await c.query(`INSERT INTO progress(order_id,phase,status,comment,updated_at) VALUES($1,$2,$3,$4,$5) ON CONFLICT(order_id,phase) DO UPDATE SET status=EXCLUDED.status,comment=EXCLUDED.comment,updated_at=EXCLUDED.updated_at`,[orderId,phase,ns,nc,now]);
 if(!old||old.status!==ns)await c.query(`INSERT INTO progress_history(company,order_number,phase,status,comment,changed_at) VALUES($1,$2,$3,$4,$5,$6)`,[or.company,or.order_number,phase,ns,nc,now]);
 await c.query('COMMIT');res.json({message:'Phase updated',status:ns,comment:nc,updatedAt:now.toISOString()});
}catch(e){try{await c.query('ROLLBACK')}catch(_){}res.status(500).json({error:e.message})}finally{c.release()}});

app.get('/api/phase-history/:orderId/:phase',auth,async(req,res)=>{try{const o=(await pool.query('SELECT company,order_number FROM orders WHERE id=$1',[req.params.orderId])).rows[0];if(!o)return res.status(404).json({error:'Nalog ne postoji.'});if(req.user.role!=='admin'&&key(o.company)!==key(req.user.company))return res.status(403).json({error:'Nemate pristup.'});const r=await pool.query(`SELECT id,status,comment,changed_at FROM progress_history WHERE company=$1 AND order_number=$2 AND phase=$3 ORDER BY changed_at DESC,id DESC`,[o.company,o.order_number,req.params.phase]);res.json({history:r.rows.map(x=>({id:x.id,status:x.status,comment:x.comment||'',changedAt:x.changed_at}))})}catch(e){res.status(500).json({error:e.message})}});

let transporter=null;try{if(process.env.EMAIL_USER&&process.env.EMAIL_PASS)transporter=nodemailer.createTransport({service:'gmail',auth:{user:process.env.EMAIL_USER,pass:process.env.EMAIL_PASS}})}catch(e){console.log('Email:',e.message)}
app.post('/api/send-report',auth,async(req,res)=>{try{if(!transporter)return res.status(400).json({error:'Email not configured'});const today=req.body.date||new Date().toLocaleDateString('sr-RS');const r=await pool.query(`SELECT o.*,COALESCE(json_agg(json_build_object('phase',p.phase,'status',p.status,'comment',p.comment,'updated_at',p.updated_at) ORDER BY p.phase) FILTER(WHERE p.phase IS NOT NULL),'[]') progress FROM orders o LEFT JOIN progress p ON o.id=p.order_id WHERE o.company=$1 GROUP BY o.id ORDER BY o.id DESC`,[req.user.company]);const active=r.rows.filter(o=>(o.progress||[]).some(p=>p.status!=='pending'||p.comment));if(!active.length){await transporter.sendMail({from:process.env.EMAIL_USER,to:req.body.email||process.env.ADMIN_EMAIL,subject:`Dnevni izveštaj - ${req.user.company} - ${today}`,text:`Dana ${today} nema aktivnosti.`});return res.json({message:'Nema aktivnosti, izveštaj poslat.'})}const x=new ExcelJS.Workbook(),ws=x.addWorksheet('Dnevni izveštaj');ws.addRow(['Nalog','Artikal','Šifra','Količina','Datum isporuke','Faza 100','Faza 200','Faza 300','Faza 400','Faza 500','Komentar']);for(const o of active){const m=Object.fromEntries((o.progress||[]).map(p=>[p.phase,p]));const s=ph=>{const p=m[ph];return p?.status==='completed'?`ZAVRŠENO - ${new Date(p.updated_at).toLocaleString('sr-RS')}`:p?.status==='problem'?`PROBLEM - ${new Date(p.updated_at).toLocaleString('sr-RS')}`:'NA ČEKANJU'};ws.addRow([o.order_number,o.name,o.code,o.quantity,o.delivery_date,s('100'),s('200'),s('300'),s('400'),s('500'),(o.progress||[]).filter(p=>p.comment).map(p=>`Faza ${p.phase}: ${p.comment}`).join('; ')]);}const buf=await x.xlsx.writeBuffer();await transporter.sendMail({from:process.env.EMAIL_USER,to:req.body.email||process.env.ADMIN_EMAIL,subject:`Dnevni izveštaj - ${req.user.company} - ${today}`,text:'U prilogu je izveštaj.',attachments:[{filename:`Izvestaj_${today.replace(/\./g,'-')}.xlsx`,content:buf}]});res.json({message:'Izveštaj poslat!',activeCount:active.length})}catch(e){res.status(500).json({error:e.message})}});

app.listen(PORT,'0.0.0.0',()=>console.log(`🚀 Server running on ${PORT}`));
