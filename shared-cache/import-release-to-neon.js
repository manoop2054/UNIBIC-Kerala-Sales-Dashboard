'use strict';
// Standalone GitHub Release -> Neon importer. Not connected to either dashboard yet.
// Run: SHARED_CACHE_DATABASE_URL="..." node shared-cache/import-release-to-neon.js
// Uses a separate Neon URL; existing dashboard database variables are never read.
const https=require('https'),http=require('http'),fs=require('fs'),os=require('os'),path=require('path'),crypto=require('crypto');
const {Transform}=require('stream');
const {pipeline}=require('stream/promises');
const ExcelJS=require('exceljs'),XLSX=require('xlsx'),{Pool}=require('pg');
const REPO='manoop2054/UNIBIC-Kerala-Sales-Dashboard';
const GSV='KL.LIVE.GSV.LINK-MANOOB.xlsx',SOH='LIVE.STOCK.xlsb';
const GSV_SHEET=process.env.GSV_SHEET_NAME||'ACX_Sales_Register',SOH_SHEET=process.env.SOH_SHEET_NAME||'LIVE STOCK REPORT';
const DIR=path.join(os.tmpdir(),'unibic-neon-import'),BATCH=100;
const pool=new Pool({connectionString:process.env.SHARED_CACHE_DATABASE_URL,ssl:process.env.SHARED_CACHE_SSL==='false'?false:{rejectUnauthorized:false},max:2,connectionTimeoutMillis:15000,statement_timeout:120000});
function get(url,n=0){return new Promise((resolve,reject)=>{if(n>8)return reject(Error('Too many redirects'));const c=url.startsWith('https:')?https:http;const q=c.get(url,{headers:{'User-Agent':'UNIBIC-Shared-Cache-Importer','Accept':'application/vnd.github+json'}},r=>{if([301,302,303,307,308].includes(r.statusCode)&&r.headers.location){r.resume();return resolve(get(new URL(r.headers.location,url).toString(),n+1));}if(r.statusCode!==200){r.resume();return reject(Error('HTTP '+r.statusCode+' for '+url));}const a=[];r.on('data',x=>a.push(x));r.on('end',()=>resolve(Buffer.concat(a)));r.on('error',reject);});q.setTimeout(180000,()=>q.destroy(Error('Download timeout')));q.on('error',reject);});}
async function download(url,file){
  const hash=crypto.createHash('sha256');let bytes=0;
  const meter=new Transform({transform(chunk,encoding,callback){bytes+=chunk.length;hash.update(chunk);callback(null,chunk);}});
  await new Promise((resolve,reject)=>{
    const request=(target,redirects=0)=>{
      if(redirects>8)return reject(Error('Too many download redirects'));
      const client=target.startsWith('https:')?https:http;
      const req=client.get(target,{headers:{'User-Agent':'UNIBIC-Shared-Cache-Importer'}},res=>{
        if([301,302,303,307,308].includes(res.statusCode)&&res.headers.location){res.resume();return request(new URL(res.headers.location,target).toString(),redirects+1);}
        if(res.statusCode!==200){res.resume();return reject(Error('Download HTTP '+res.statusCode+' for '+target));}
        pipeline(res,meter,fs.createWriteStream(file)).then(resolve,reject);
      });
      req.setTimeout(180000,()=>req.destroy(Error('Download timeout')));
      req.on('error',reject);
    };
    request(url);
  });
  if(!bytes)throw Error('Downloaded asset is empty: '+path.basename(file));
  return{bytes,sha:hash.digest('hex')};
}
function val(v){if(v==null)return null;if(v instanceof Date)return v.toISOString();if(typeof v==='object'){if(Array.isArray(v.richText))return v.richText.map(x=>x.text||'').join('');if('result'in v)return val(v.result);if('text'in v)return v.text;return null;}return v;}
function norm(s){return String(s||'').toLowerCase().replace(/[^a-z0-9]/g,'');}
function pick(o,...names){const m=new Map(Object.entries(o).map(([k,v])=>[norm(k),v]));for(const n of names){const v=m.get(norm(n));if(v!==undefined&&v!==null&&v!=='')return v;}return null;}
function num(v){if(v==null||v==='')return null;const n=Number(String(v).replace(/,/g,''));return Number.isFinite(n)?n:null;}
function date(v){if(!v)return null;const s=String(v).trim();let m=s.match(/^(\d{1,2})[-/](\d{1,2})[-/](\d{2,4})/);if(m){let y=+m[3];if(y<100)y+=y>=70?1900:2000;const d=new Date(Date.UTC(y,+m[2]-1,+m[1]));return d.getUTCFullYear()===y&&d.getUTCMonth()===+m[2]-1&&d.getUTCDate()===+m[1]?d.toISOString().slice(0,10):null;}m=s.match(/^(\d{4})-(\d{2})-(\d{2})/);return m?m[0]:null;}
async function insert(client,table,id,rows){for(let i=0;i<rows.length;i+=BATCH){const p=rows.slice(i,i+BATCH).map(x=>({...x,refresh_id:id}));if(table==='gsv_sales'){await client.query('INSERT INTO public.gsv_sales(refresh_id,source_row_number,transaction_type,posting_date,item_id,description,location_code,quantity_in_pcs,quantity_in_cbo,amount_to_customer,invoice_no,sell_to_customer_no,sell_to_customer_name,ship_to_code,ship_to_name,sku_group,bg,raw_data) SELECT refresh_id,source_row_number,transaction_type,posting_date,item_id,description,location_code,quantity_in_pcs,quantity_in_cbo,amount_to_customer,invoice_no,sell_to_customer_no,sell_to_customer_name,ship_to_code,ship_to_name,sku_group,bg,raw_data FROM jsonb_to_recordset($1::jsonb) AS x(refresh_id uuid,source_row_number bigint,transaction_type text,posting_date date,item_id text,description text,location_code text,quantity_in_pcs numeric,quantity_in_cbo numeric,amount_to_customer numeric,invoice_no text,sell_to_customer_no text,sell_to_customer_name text,ship_to_code text,ship_to_name text,sku_group text,bg text,raw_data jsonb)',[JSON.stringify(p)]);}else{await client.query('INSERT INTO public.live_stock(refresh_id,source_row_number,item_id,description,warehouse,batch_no,mrp,mfg_date,expiry_date,cbo,quarantine_qty_cbo,total_main_qrt,shelf_life,remaining_shelf_life,case_size,units,total_qty_in_units,quarantine_units,net_weight,total_weight,hsn_code,brand_code,brand_family,pack_family,brand_basket_code,brand_short_name,category,data_area_id,inventory_location_type,type,sku_group,raw_data) SELECT refresh_id,source_row_number,item_id,description,warehouse,batch_no,mrp,mfg_date,expiry_date,cbo,quarantine_qty_cbo,total_main_qrt,shelf_life,remaining_shelf_life,case_size,units,total_qty_in_units,quarantine_units,net_weight,total_weight,hsn_code,brand_code,brand_family,pack_family,brand_basket_code,brand_short_name,category,data_area_id,inventory_location_type,type,sku_group,raw_data FROM jsonb_to_recordset($1::jsonb) AS x(refresh_id uuid,source_row_number bigint,item_id text,description text,warehouse text,batch_no text,mrp numeric,mfg_date date,expiry_date date,cbo numeric,quarantine_qty_cbo numeric,total_main_qrt numeric,shelf_life numeric,remaining_shelf_life numeric,case_size numeric,units numeric,total_qty_in_units numeric,quarantine_units numeric,net_weight numeric,total_weight numeric,hsn_code text,brand_code text,brand_family text,pack_family text,brand_basket_code text,brand_short_name text,category text,data_area_id text,inventory_location_type text,type text,sku_group text,raw_data jsonb)',[JSON.stringify(p)]);}}}
async function importGsv(c,id,file){
  const reader=new ExcelJS.stream.xlsx.WorkbookReader(file,{sharedStrings:'cache',hyperlinks:'ignore',worksheets:'emit',styles:'ignore'});
  let header=null,batch=[],count=0,sourceRows=0,invalidDate=0,found=false,minDate='',maxDate='';
  for await(const sh of reader){
    if(sh.name!==GSV_SHEET)continue;
    found=true;
    for await(const row of sh){
      const a=row.values||[];
      if(!header){
        header=a.map(val);
        const keys=header.map(norm);
        for(const aliases of [['ItemId','Item ID','ItemCode','Item Code'],['PostingDate','Posting Date','Date','Invoice Date'],['QuantityinCBO','Quantity in CBO','QuantityinCBD','CBO','CBB','Quantity']]){
          if(!aliases.some(x=>keys.includes(norm(x))))throw Error('GSV missing required header (one of): '+aliases.join(', '));
        }
        continue;
      }
      const raw={};
      for(let i=1;i<header.length;i++){const k=String(header[i]||'').trim(),v=val(a[i]);if(k&&v!==null&&v!=='')raw[k]=v;}
      if(!Object.keys(raw).length)continue;
      sourceRows++;
      const item=String(pick(raw,'ItemId','Item ID','ItemCode','Item Code')||'').trim();
      const postingDate=date(pick(raw,'PostingDate','Posting Date','Date','Invoice Date'));
      const qty=num(pick(raw,'QuantityinCBO','Quantity in CBO','QuantityinCBD','CBO','CBB','Quantity'));
      if(!item||!postingDate||qty===null){if(!postingDate)invalidDate++;continue;}
      if(!minDate||postingDate<minDate)minDate=postingDate;
      if(!maxDate||postingDate>maxDate)maxDate=postingDate;
      const shipCode=pick(raw,'Ship Code','ShipCode','Ship To Code','ShipToCode','Ship To Customer Code','DBR Code','DBRCode','Customer Code','CustomerCode','Debtor Code','Customer Id','Account Code');
      const shipName=pick(raw,'Ship To Name','ShipToName','Customer Name','CustomerName','Debtor Name','Account Name');
      const transactionType=pick(raw,'Transaction_Type','Transaction Type','Document Type');
      const rawSafe={
        Transaction_Type:transactionType,PostingDate:pick(raw,'PostingDate','Posting Date'),Invoice_No:pick(raw,'Invoice_No','Invoice No','Invoice Number'),
        LocationCode:pick(raw,'LocationCode','Location Code','Location_Code','CFA','Warehouse'),ItemId:item,Description:pick(raw,'Description'),
        QuantityinPcs:pick(raw,'QuantityinPcs','Quantity in Pcs'),QuantityinCBO:qty,AmountToCustomer:pick(raw,'AmountToCustomer','Amount To Customer','GSV Amount','Amount'),
        Ship_Code:shipCode,Ship_To_Name:shipName,Sell_to_Customer_No:pick(raw,'Sell_to_Customer_No','Sell To Customer No'),
        Sell_to_Customer_Name:pick(raw,'Sell_to_Customer_Name','Sell To Customer Name'),SKU_Group:pick(raw,'SKU_Group','SKU Group'),
        BG:pick(raw,'BG'),Brand:pick(raw,'Brand'),BrandFamily:pick(raw,'BrandFamily'),PackFamily:pick(raw,'PackFamily'),CategoryName:pick(raw,'CategoryName')
      };
      batch.push({
        source_row_number:sourceRows,transaction_type:transactionType,posting_date:postingDate,item_id:item,
        description:pick(raw,'Description'),location_code:rawSafe.LocationCode==null?null:String(rawSafe.LocationCode).trim(),
        quantity_in_pcs:num(pick(raw,'QuantityinPcs','Quantity in Pcs')),quantity_in_cbo:qty,
        amount_to_customer:num(pick(raw,'AmountToCustomer','Amount To Customer','GSV Amount','Amount')),
        invoice_no:pick(raw,'Invoice_No','Invoice No','Invoice Number'),
        sell_to_customer_no:pick(raw,'Sell_to_Customer_No','Sell To Customer No'),
        sell_to_customer_name:pick(raw,'Sell_to_Customer_Name','Sell To Customer Name'),
        ship_to_code:shipCode==null?null:String(shipCode).trim(),ship_to_name:shipName==null?null:String(shipName).trim(),
        sku_group:pick(raw,'SKU_Group','SKU Group'),bg:pick(raw,'BG'),raw_data:rawSafe
      });
      count++;
      if(batch.length===BATCH){await insert(c,'gsv_sales',id,batch);batch=[];}
    }
    break;
  }
  if(!found||!count)throw Error('GSV worksheet missing or no valid rows: '+GSV_SHEET);
  const invalidDateRate=sourceRows?invalidDate/sourceRows:1;
  if(count<Number(process.env.MIN_GSV_ROWS||1000))throw Error('GSV validation failed: only '+count+' valid rows (minimum '+(process.env.MIN_GSV_ROWS||1000)+')');
  if(invalidDateRate>Number(process.env.MAX_GSV_INVALID_DATE_RATE||0.05))throw Error('GSV validation failed: invalid/missing dates in '+(invalidDateRate*100).toFixed(2)+'% of source rows');
  if(!minDate||!maxDate)throw Error('GSV date coverage could not be established');
  if(batch.length)await insert(c,'gsv_sales',id,batch);
  return{rows:count,sourceRows,invalidDateRows:invalidDate,minDate,maxDate};
}
async function importSoh(c,id,file){
  const wb=XLSX.readFile(file,{cellDates:true}),name=wb.SheetNames.includes(SOH_SHEET)?SOH_SHEET:null;
  if(!name)throw Error('Required LIVE SOH worksheet missing: '+SOH_SHEET+'; available sheets: '+wb.SheetNames.join(', '));
  const rows=XLSX.utils.sheet_to_json(wb.Sheets[name],{defval:'',raw:false});
  if(!rows.length)throw Error('LIVE SOH data empty');
  const headers=Object.keys(rows[0]).map(norm);
  for(const aliases of [['ITEMID','ITEM ID','ITEMCODE'],['DESCRIPTION','ITEM DESCRIPTION'],['WAREHOUSE','LOCATION','INVENTORY LOCATION']]){
    if(!aliases.some(x=>headers.includes(norm(x))))throw Error('LIVE SOH missing required header (one of): '+aliases.join(', '));
  }
  let count=0,batch=[];
  for(const raw of rows){
    if(!Object.values(raw).some(v=>v!==''&&v!=null))continue;
    const item=pick(raw,'ITEMID','ITEM ID','ITEMCODE'),warehouse=pick(raw,'WAREHOUSE','LOCATION','INVENTORY LOCATION');
    if(!item||!warehouse)continue;
    count++;
    batch.push({
      source_row_number:count,item_id:String(item).trim(),description:pick(raw,'DESCRIPTION','ITEM DESCRIPTION'),
      warehouse:String(warehouse).trim(),batch_no:pick(raw,'BATCHNO','BATCH NO','BATCH'),
      mrp:num(pick(raw,'MRP')),mfg_date:date(pick(raw,'MFG','MFG DATE','MANUFACTURING DATE')),
      expiry_date:date(pick(raw,'EXPIRY_DATE','EXPIRY DATE','EXP DATE')),
      cbo:num(pick(raw,'CBO')),quarantine_qty_cbo:num(pick(raw,'QUARANTINE_QTY_CBO','QUARANTINE QTY CBO')),
      total_main_qrt:num(pick(raw,'TOTAL_MAIN_QRT','TOTAL MAIN QRT')),shelf_life:num(pick(raw,'SHELFLIFE','SHELF LIFE')),
      remaining_shelf_life:num(pick(raw,'REMAININGSHELFLIFE','REMAINING SHELF LIFE')),
      case_size:num(pick(raw,'CASESIZE','CASE SIZE')),units:num(pick(raw,'UNITS')),
      total_qty_in_units:num(pick(raw,'TOTALQTYINUNITS','TOTAL QTY IN UNITS')),
      quarantine_units:num(pick(raw,'QUARANTINEUNITS','QUARANTINE UNITS')),
      net_weight:num(pick(raw,'NETWEIGHT','NET WEIGHT')),total_weight:num(pick(raw,'TOTAL_WEIGHT','TOTAL WEIGHT')),
      hsn_code:pick(raw,'HSNCODE','HSN CODE'),brand_code:pick(raw,'BRANDCODE','BRAND CODE'),
      brand_family:pick(raw,'BRANDFAMILY','BRAND FAMILY'),pack_family:pick(raw,'PACKFAMILY','PACK FAMILY'),
      brand_basket_code:pick(raw,'BRANDBASKETCODE','BRAND BASKET CODE'),brand_short_name:pick(raw,'BRANDSHORTNAME','BRAND SHORT NAME'),
      category:pick(raw,'CATEGORY','CATEGORYNAME'),data_area_id:pick(raw,'DATAAREAID','DATA AREA ID'),
      inventory_location_type:pick(raw,'INVENTLOCATIONTYPE','INVENT LOCATION TYPE'),
      type:pick(raw,'TYPE'),sku_group:pick(raw,'ItemAttribute.SKUGroup','SKUGroup','SKU GROUP'),raw_data:raw
    });
    if(batch.length===BATCH){await insert(c,'live_stock',id,batch);batch=[];}
  }
  if(count<Number(process.env.MIN_SOH_ROWS||100))throw Error('LIVE SOH validation failed: only '+count+' valid rows (minimum '+(process.env.MIN_SOH_ROWS||100)+')');
  if(batch.length)await insert(c,'live_stock',id,batch);
  return{rows:count,sourceRows:rows.length,worksheet:name};
}
async function main(){if(!process.env.SHARED_CACHE_DATABASE_URL)throw Error('Set SHARED_CACHE_DATABASE_URL; existing dashboard DB variables are not used.');await fs.promises.mkdir(DIR,{recursive:true});const tag=process.env.GITHUB_RELEASE_TAG;const meta=JSON.parse((await get(tag?'https://api.github.com/repos/'+REPO+'/releases/tags/'+encodeURIComponent(tag):'https://api.github.com/repos/'+REPO+'/releases/latest')).toString());const assets=new Map((meta.assets||[]).map(a=>[a.name,a.browser_download_url]));const urls=[process.env.GSV_SHARE_URL||assets.get(GSV),process.env.SOH_SHARE_URL||assets.get(SOH)];if(urls.some(x=>!x))throw Error('Both GSV and SOH assets are required in release '+meta.tag_name);const files=[path.join(DIR,'gsv.xlsx'),path.join(DIR,'soh.xlsb')];console.log('Downloading release '+meta.tag_name);const [gm,sm]=await Promise.all([download(urls[0],files[0]),download(urls[1],files[1])]);const c=await pool.connect();let gid=null,sid=null;const attempted=[];try{await c.query('BEGIN');await c.query("SELECT pg_advisory_xact_lock(hashtext('unibic-shared-cache-import'))");const active=await c.query('SELECT active_gsv_refresh_id,active_live_soh_refresh_id FROM public.cache_active_datasets WHERE singleton=TRUE FOR UPDATE');const old=active.rows[0]||{};const prev=await c.query('SELECT id,source_name,file_checksum FROM public.data_refresh_log WHERE refresh_status=\'active\' AND source_name IN (\'GSV\',\'LIVE_SOH\') ORDER BY started_at DESC');const checks=new Map(prev.rows.map(x=>[x.source_name,x.file_checksum]));if(checks.get('GSV')!==gm.sha){gid=crypto.randomUUID();attempted.push({id:gid,source:'GSV',asset:GSV,sha:gm.sha,bytes:gm.bytes});await c.query('INSERT INTO public.data_refresh_log(id,source_name,release_tag,asset_name,file_checksum,file_bytes,refresh_status) VALUES($1,\'GSV\',$2,$3,$4,$5,\'processing\')',[gid,meta.tag_name,GSV,gm.sha,gm.bytes]);const n=await importGsv(c,gid,files[0]);await c.query('UPDATE public.data_refresh_log SET row_count=$2,refresh_status=\'validated\',completed_at=NOW(),validation_summary=$3::jsonb WHERE id=$1',[gid,n,JSON.stringify({sheet:GSV_SHEET,sha256:gm.sha})]);}if(checks.get('LIVE_SOH')!==sm.sha){sid=crypto.randomUUID();attempted.push({id:sid,source:'LIVE_SOH',asset:SOH,sha:sm.sha,bytes:sm.bytes});await c.query('INSERT INTO public.data_refresh_log(id,source_name,release_tag,asset_name,file_checksum,file_bytes,refresh_status) VALUES($1,\'LIVE_SOH\',$2,$3,$4,$5,\'processing\')',[sid,meta.tag_name,SOH,sm.sha,sm.bytes]);const n=await importSoh(c,sid,files[1]);await c.query('UPDATE public.data_refresh_log SET row_count=$2,refresh_status=\'validated\',completed_at=NOW(),validation_summary=$3::jsonb WHERE id=$1',[sid,n,JSON.stringify({sheet:SOH_SHEET,sha256:sm.sha})]);}const ng=gid||old.active_gsv_refresh_id,ns=sid||old.active_live_soh_refresh_id;if(!ng||!ns)throw Error('Both data sources must be imported and validated before first activation.');await c.query('INSERT INTO public.cache_active_datasets(singleton,active_gsv_refresh_id,active_live_soh_refresh_id,updated_at) VALUES(TRUE,$1,$2,NOW()) ON CONFLICT(singleton) DO UPDATE SET active_gsv_refresh_id=EXCLUDED.active_gsv_refresh_id,active_live_soh_refresh_id=EXCLUDED.active_live_soh_refresh_id,updated_at=NOW()',[ng,ns]);if(gid)await c.query("UPDATE public.data_refresh_log SET refresh_status='superseded' WHERE source_name='GSV' AND refresh_status='active' AND id<>$1",[gid]);if(sid)await c.query("UPDATE public.data_refresh_log SET refresh_status='superseded' WHERE source_name='LIVE_SOH' AND refresh_status='active' AND id<>$1",[sid]);for(const id of [gid,sid].filter(Boolean))await c.query('UPDATE public.data_refresh_log SET refresh_status=\'active\' WHERE id=$1',[id]);await c.query('COMMIT');console.log('Validated shared cache activated for '+meta.tag_name);}catch(e){await c.query('ROLLBACK').catch(()=>{});for(const item of attempted){try{await pool.query('INSERT INTO public.data_refresh_log(id,source_name,release_tag,asset_name,file_checksum,file_bytes,refresh_status,error_message,completed_at,validation_summary) VALUES($1,$2,$3,$4,$5,$6,\'failed\',$7,NOW(),$8::jsonb)',[item.id,item.source,meta.tag_name,item.asset,item.sha,item.bytes,String(e.message||e).slice(0,4000),JSON.stringify({stage:'import',preservedPreviousActiveCache:true})]);}catch(logError){console.error('Could not persist failure log for '+item.source+':',logError.message);}}throw e;}finally{c.release();}}main().catch(e=>{console.error('Import failed:',e.stack||e.message);process.exitCode=1;}).finally(()=>pool.end().catch(()=>{}));
