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
const DIR=path.join(os.tmpdir(),'unibic-neon-import'),BATCH=200;
const pool=new Pool({connectionString:process.env.SHARED_CACHE_DATABASE_URL,ssl:process.env.SHARED_CACHE_SSL==='false'?false:{rejectUnauthorized:false},max:2,connectionTimeoutMillis:15000,statement_timeout:120000});
function get(url,n=0){return new Promise((resolve,reject)=>{if(n>8)return reject(Error('Too many redirects'));const c=url.startsWith('https:')?https:http;const headers={'User-Agent':'UNIBIC-Shared-Cache-Importer','Accept':'application/vnd.github+json'};if(url.startsWith('https://api.github.com/')&&process.env.GITHUB_TOKEN)headers.Authorization='Bearer '+process.env.GITHUB_TOKEN;const q=c.get(url,{headers},r=>{if([301,302,303,307,308].includes(r.statusCode)&&r.headers.location){r.resume();return resolve(get(new URL(r.headers.location,url).toString(),n+1));}if(r.statusCode!==200){r.resume();return reject(Error('HTTP '+r.statusCode+' for '+url));}const a=[];r.on('data',x=>a.push(x));r.on('end',()=>resolve(Buffer.concat(a)));r.on('error',reject);});q.setTimeout(180000,()=>q.destroy(Error('Download timeout')));q.on('error',reject);});}
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
function date(v){if(v==null||v==='')return null;const serial=typeof v==='number'?v:(/^\\d+(?:\\.\\d+)?$/.test(String(v).trim())?Number(v):NaN);if(Number.isFinite(serial)&&serial>=1&&serial<=100000){const d=new Date(Date.UTC(1899,11,30)+Math.floor(serial)*86400000);return d.toISOString().slice(0,10);}const s=String(v).trim();let m=s.match(/^(\d{1,2})[-/](\d{1,2})[-/](\d{2,4})/);if(m){let y=+m[3];if(y<100)y+=y>=70?1900:2000;const d=new Date(Date.UTC(y,+m[2]-1,+m[1]));return d.getUTCFullYear()===y&&d.getUTCMonth()===+m[2]-1&&d.getUTCDate()===+m[1]?d.toISOString().slice(0,10):null;}m=s.match(/^(\d{4})-(\d{2})-(\d{2})/);return m?m[0]:null;}
async function queryBatch(sql,params){
  const retryable=new Set(['08P01','08006','08003','57P01','57P02','57P03','53300']);
  for(let attempt=0;attempt<4;attempt++){
    try{return await pool.query(sql,params);}
    catch(error){
      const transient=retryable.has(String(error.code||''))||/connection terminated|connection reset|socket hang up|server closed the connection/i.test(String(error.message||''));
      if(!transient||attempt===3)throw error;
      console.warn('[NEON BATCH RETRY] code='+(error.code||'unknown')+' attempt='+(attempt+1)+'; retrying the same idempotent batch');
      await new Promise(resolve=>setTimeout(resolve,500*(attempt+1)));
    }
  }
}
async function cleanupAbandonedCandidates(c){
  const active=await c.query('SELECT active_gsv_refresh_id,active_live_soh_refresh_id FROM public.cache_active_datasets WHERE singleton=TRUE');
  const activeIds=new Set(active.rows.flatMap(row=>[row.active_gsv_refresh_id,row.active_live_soh_refresh_id]).filter(Boolean).map(String));
  const pending=await c.query("SELECT id,source_name FROM public.data_refresh_log WHERE refresh_status IN ('processing','validated') AND source_name IN ('GSV','LIVE_SOH') ORDER BY started_at");
  for(const row of pending.rows){
    const id=String(row.id);
    if(activeIds.has(id))continue;
    if(row.source_name==='GSV'){
      const aggregateTable=await c.query("SELECT to_regclass('public.gsv_mbq_aggregate') AS name");
      if(aggregateTable.rows[0]?.name)await c.query('DELETE FROM public.gsv_mbq_aggregate WHERE refresh_id=$1',[id]);
      await c.query('DELETE FROM public.gsv_sales WHERE refresh_id=$1',[id]);
    }else{
      await c.query('DELETE FROM public.live_stock WHERE refresh_id=$1',[id]);
    }
    await c.query("UPDATE public.data_refresh_log SET refresh_status='failed',completed_at=NOW(),error_message='Previous importer stopped before validation; incomplete candidate rows were removed safely before retry.',validation_summary=$2::jsonb WHERE id=$1 AND refresh_status='processing'",[id,JSON.stringify({stage:'recovered-abandoned-import',preservedPreviousActiveCache:true})]);
    console.warn('[IMPORT RECOVERY] Removed incomplete '+row.source_name+' candidate '+id+'; active cache unchanged.');
  }
}
async function insert(client,table,id,rows){
  for(let i=0;i<rows.length;i+=BATCH){
    const p=rows.slice(i,i+BATCH).map(x=>({...x,refresh_id:id}));
    if(table==='gsv_sales'){
      await queryBatch(`INSERT INTO public.gsv_sales(
        refresh_id,source_row_number,transaction_type,return_invoices,line_discount_amount,
        invoice_no,posting_date,order_no,order_date,sell_to_customer_name,sell_to_customer_no,
        billed_to_code,billed_to_name,ship_to_code,ship_to_name,external_doc_no,location_code,
        customer_posting_group,item_id,description,uom,ship_date,quantity_in_pcs,quantity_in_cbo,
        unit_price,scheme_discount,scheme_discount_percent,indv_discount,line_discount_percent,
        discount_percent,disc_amount,gst_base_amount,amount_to_customer,net_weight,case_qty,
        line_amount,cgst,sgst,igst,gst_type,hsn,mrp_price,posting_group,area_code,region_name,
        business_group_name,chain_name,tbi_zone_name,ccity_code_name,nkam_abm,assesable_value,
        sales_worker_responsible,voucher,anchor_name,anchor_zone_name,category_name,brand_basket,
        brand,brand_family,sku_group,pack_family,brand_short_name,city_group,quantity_kg,
        gsv_in_lakh,mrp_value,bg,raw_data
      ) SELECT
        refresh_id,source_row_number,transaction_type,return_invoices,line_discount_amount,
        invoice_no,posting_date,order_no,order_date,sell_to_customer_name,sell_to_customer_no,
        billed_to_code,billed_to_name,ship_to_code,ship_to_name,external_doc_no,location_code,
        customer_posting_group,item_id,description,uom,ship_date,quantity_in_pcs,quantity_in_cbo,
        unit_price,scheme_discount,scheme_discount_percent,indv_discount,line_discount_percent,
        discount_percent,disc_amount,gst_base_amount,amount_to_customer,net_weight,case_qty,
        line_amount,cgst,sgst,igst,gst_type,hsn,mrp_price,posting_group,area_code,region_name,
        business_group_name,chain_name,tbi_zone_name,ccity_code_name,nkam_abm,assesable_value,
        sales_worker_responsible,voucher,anchor_name,anchor_zone_name,category_name,brand_basket,
        brand,brand_family,sku_group,pack_family,brand_short_name,city_group,quantity_kg,
        gsv_in_lakh,mrp_value,bg,raw_data
      FROM jsonb_to_recordset($1::jsonb) AS x(
        refresh_id uuid,source_row_number bigint,transaction_type text,return_invoices text,
        line_discount_amount numeric,invoice_no text,posting_date date,order_no text,order_date date,
        sell_to_customer_name text,sell_to_customer_no text,billed_to_code text,billed_to_name text,
        ship_to_code text,ship_to_name text,external_doc_no text,location_code text,
        customer_posting_group text,item_id text,description text,uom text,ship_date text,
        quantity_in_pcs numeric,quantity_in_cbo numeric,unit_price numeric,scheme_discount numeric,
        scheme_discount_percent numeric,indv_discount numeric,line_discount_percent numeric,
        discount_percent numeric,disc_amount numeric,gst_base_amount numeric,amount_to_customer numeric,
        net_weight numeric,case_qty numeric,line_amount numeric,cgst numeric,sgst numeric,igst numeric,
        gst_type text,hsn text,mrp_price numeric,posting_group text,area_code text,region_name text,
        business_group_name text,chain_name text,tbi_zone_name text,ccity_code_name text,nkam_abm text,
        assesable_value numeric,sales_worker_responsible text,voucher text,anchor_name text,
        anchor_zone_name text,category_name text,brand_basket text,brand text,brand_family text,
        sku_group text,pack_family text,brand_short_name text,city_group text,quantity_kg numeric,
        gsv_in_lakh numeric,mrp_value numeric,bg text,raw_data jsonb
      ) ON CONFLICT (refresh_id, source_row_number) DO NOTHING`,[JSON.stringify(p)]);
    }else{
      await queryBatch('INSERT INTO public.live_stock(refresh_id,source_row_number,item_id,description,warehouse,batch_no,mrp,mfg_date,expiry_date,cbo,quarantine_qty_cbo,total_main_qrt,shelf_life,remaining_shelf_life,case_size,units,total_qty_in_units,quarantine_units,net_weight,total_weight,hsn_code,brand_code,brand_family,pack_family,brand_basket_code,brand_short_name,category,data_area_id,inventory_location_type,type,sku_group,raw_data) SELECT refresh_id,source_row_number,item_id,description,warehouse,batch_no,mrp,mfg_date,expiry_date,cbo,quarantine_qty_cbo,total_main_qrt,shelf_life,remaining_shelf_life,case_size,units,total_qty_in_units,quarantine_units,net_weight,total_weight,hsn_code,brand_code,brand_family,pack_family,brand_basket_code,brand_short_name,category,data_area_id,inventory_location_type,type,sku_group,raw_data FROM jsonb_to_recordset($1::jsonb) AS x(refresh_id uuid,source_row_number bigint,item_id text,description text,warehouse text,batch_no text,mrp numeric,mfg_date date,expiry_date date,cbo numeric,quarantine_qty_cbo numeric,total_main_qrt numeric,shelf_life numeric,remaining_shelf_life numeric,case_size numeric,units numeric,total_qty_in_units numeric,quarantine_units numeric,net_weight numeric,total_weight numeric,hsn_code text,brand_code text,brand_family text,pack_family text,brand_basket_code text,brand_short_name text,category text,data_area_id text,inventory_location_type text,type text,sku_group text,raw_data jsonb) ON CONFLICT (refresh_id, source_row_number) DO NOTHING',[JSON.stringify(p)]);
    }
  }
}
async function importGsv(c,id,file){
  const reader=new ExcelJS.stream.xlsx.WorkbookReader(file,{sharedStrings:'cache',hyperlinks:'ignore',worksheets:'emit',styles:'ignore'});
  let header=null,batch=[],count=0,sourceRows=0,invalidDate=0,missingItem=0,missingQty=0,found=false,minDate='',maxDate='';
  const sampleRows=[];
  const availableSheets=[];
  for await(const sh of reader){
    availableSheets.push(sh.name);
    if(norm(sh.name)!==norm(GSV_SHEET))continue;
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
      if(sourceRows%1000===0)console.log('[GSV IMPORT] progress sourceRows='+sourceRows+' validRows='+count+' pendingRows='+batch.length);
      const item=String(pick(raw,'ItemId','Item ID','ItemCode','Item Code')||'').trim();
      const postingDate=date(pick(raw,'PostingDate','Posting Date','Date','Invoice Date'));
      const qty=num(pick(raw,'QuantityinCBO','Quantity in CBO','QuantityinCBD','CBO','CBB','Quantity'));
      if(sampleRows.length<3)sampleRows.push({sourceRow:sourceRows,itemId:item||null,postingDateRaw:pick(raw,'PostingDate','Posting Date','Date','Invoice Date'),postingDateParsed:postingDate,qtyRaw:pick(raw,'QuantityinCBO','Quantity in CBO','QuantityinCBD','CBO','CBB','Quantity'),qtyParsed:qty,firstCells:a.slice(1,6).map(val)});
      if(!item||!postingDate||qty===null){if(!postingDate)invalidDate++;if(!item)missingItem++;if(qty===null)missingQty++;continue;}
      if(!minDate||postingDate<minDate)minDate=postingDate;
      if(!maxDate||postingDate>maxDate)maxDate=postingDate;
      const shipCode=pick(raw,'Ship Code','ShipCode','Ship To Code','ShipToCode','Ship To Customer Code','DBR Code','DBRCode','Customer Code','CustomerCode','Debtor Code','Customer Id','Account Code');
      const shipName=pick(raw,'Ship To Name','ShipToName','Customer Name','CustomerName','Debtor Name','Account Name');
      const transactionType=pick(raw,'Transaction_Type','Transaction Type','Document Type');
      // Preserve every non-sensitive source field in raw_data. The structured columns
      // below are the stable fields consumed by the two dashboards.
      const safeRaw=Object.fromEntries(Object.entries(raw).filter(([k])=>!/(email|phone|gstin|address|pincode|contact.?person)/i.test(k)));
      const get=(...keys)=>pick(raw,...keys);
      const asText=v=>v==null||v===''?null:String(v).trim();
      const structured={
        transaction_type:asText(get('Transaction_Type','Transaction Type','Document Type')),
        return_invoices:asText(get('Return_Invoices','Return Invoice','Return Invoices')),
        line_discount_amount:num(get('Line_Discount_Amount','Line Discount Amount','INDV Amount')),
        invoice_no:asText(get('Invoice_No','Invoice No','Invoice Number','Invoice')),
        posting_date:postingDate,
        order_no:asText(get('Order_No','Order No','Order')),
        order_date:date(get('Order_Date','Order Date')),
        sell_to_customer_name:asText(get('Sell_to_Customer_Name','Sell To Customer Name','Customer_Name','Customer Name')),
        sell_to_customer_no:asText(get('Sell_to_Customer_No','Sell To Customer No','Customer_Account')),
        billed_to_code:asText(get('Billed_to_Code','Billed To Code','DBR_Code','DBR Code')),
        billed_to_name:asText(get('Billed_to_Name','Billed To Name','DBR_Name','DBR Name')),
        ship_to_code:asText(get('Ship_to_Code','Ship to Code','Ship Code','ShipCode','Ship To Code','ShipToCode','Ship To Customer Code','DBR Code','DBRCode','Customer Code','CustomerCode','Debtor Code','Customer Id','Account Code')),
        ship_to_name:asText(get('Ship_to_Name','Ship To Name','ShipToName','Customer Name','CustomerName','Debtor Name','Account Name')),
        external_doc_no:asText(get('ExternalDocNo','External Doc No','External Document No')),
        location_code:asText(get('LocationCode','Location Code','Location_Code','CFA','Warehouse','Branch','Site')),
        customer_posting_group:asText(get('Customer_Posting_Group','Customer Posting Group')),
        item_id:item,
        description:asText(get('Description','Item Description')),
        uom:asText(get('UOM','Unit of Measure')),
        ship_date:asText(get('Ship_Date','Ship Date')),
        quantity_in_pcs:num(get('QuantityinPcs','Quantity in Pcs','Qty PCS')),
        quantity_in_cbo:qty,
        unit_price:num(get('Unit_Price','UNIT PRICE','Unit Price','UnitPrice')),
        scheme_discount:num(get('Scheme_Discount','Scheme Discount')),
        scheme_discount_percent:num(get('Scheme_Discount_Percent','Scheme Discount Percent')),
        indv_discount:num(get('INDV_discount','INDV Discount','Discount')),
        line_discount_percent:num(get('Line_Discount_Percent','Line Discount Percent','LineDiscountPercent')),
        discount_percent:num(get('Discount_Percent','Discount Percent')),
        disc_amount:num(get('Disc_Amount','Disc Amount','Discount Amount','INDV Amount')),
        gst_base_amount:num(get('GST_Base_Amount','GST Base Amount','GST_Base')),
        amount_to_customer:num(get('AmountToCustomer','Amount To Customer','GSV Amount','GSV','Amount')),
        net_weight:num(get('Net_Weight','Net Weight')),
        case_qty:num(get('Case_Qty','Case Qty')),
        line_amount:num(get('Line_Amount','Line Amount')),
        cgst:num(get('CGST')),sgst:num(get('SGST')),igst:num(get('IGST')),
        gst_type:asText(get('GST_Type','GST Type')),hsn:asText(get('HSN','HSN Code')),
        mrp_price:num(get('MRP_Price','MRP Price','MRP')),
        posting_group:asText(get('Posting_Group','Posting Group')),
        area_code:asText(get('AreaCode','Area Code','Area','Area Name','AREA NAME','Area_Name','AREA_NAME')),
        region_name:asText(get('REGION','Region','region','Region Name','REGION NAME','Region_Name','REGION_NAME')),
        business_group_name:asText(get('Business_Group_Name','Business Group Name')),
        chain_name:asText(get('Chain_Name','Chain Name')),
        tbi_zone_name:asText(get('TBI_Zone_Name','TBI Zone Name')),
        ccity_code_name:asText(get('CCity_Code_Name','CCity Code Name')),
        nkam_abm:asText(get('NKAM_ABM','NKAM / ABM','ABM','ABM Name')),
        assesable_value:num(get('AssesableValue','AssessableValue','Assesable Value')),
        sales_worker_responsible:asText(get('Sales_Worker_Responsible','Sales Worker Responsible')),
        voucher:asText(get('Voucher')),
        anchor_name:asText(get('AnchorName','Anchor Name','Anchor')),
        anchor_zone_name:asText(get('AnchorZoneName','Anchor Zone Name','ANCHOR ZONENAME','Anchor Zone','AnchorZone')),
        category_name:asText(get('CategoryName','Category Name')),
        brand_basket:asText(get('Brand_Basket','Brand Basket')),
        brand:asText(get('Brand','BrandName')),
        brand_family:asText(get('BrandFamily','Brand Family')),
        sku_group:asText(get('SKU_Group','SKU Group')),
        pack_family:asText(get('PackFamily','Pack Family')),
        brand_short_name:asText(get('BrandShortName','Brand Short Name')),
        city_group:asText(get('City_Group','City Group')),
        quantity_kg:num(get('Quantity_KG','Quantity KG')),
        gsv_in_lakh:num(get('GSV IN LAKH','GSV_In_Lakh')),
        mrp_value:num(get('MRP_Value','MRP Value')),
        bg:asText(get('BG'))
      };
      batch.push({source_row_number:sourceRows,...structured,raw_data:safeRaw});
      count++;
      if(batch.length===BATCH){await insert(c,'gsv_sales',id,batch);batch=[];if(count%10000===0)console.log('[GSV IMPORT] committed rows='+count+' sourceRows='+sourceRows);}
    }
    break;
  }
  if(!found)throw Error('GSV worksheet missing: expected '+GSV_SHEET+'; available worksheets: '+availableSheets.join(' | '));
  if(!count)throw Error('GSV worksheet found but no valid rows: '+GSV_SHEET+'; sourceRows='+sourceRows+'; missingItem='+missingItem+'; invalidDate='+invalidDate+'; missingQty='+missingQty+'; samples='+JSON.stringify(sampleRows));
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
    if(batch.length===BATCH){await insert(c,'live_stock',id,batch);batch=[];if(count%5000===0)console.log('[LIVE SOH IMPORT] committed rows='+count);}
  }
  if(count<Number(process.env.MIN_SOH_ROWS||100))throw Error('LIVE SOH validation failed: only '+count+' valid rows (minimum '+(process.env.MIN_SOH_ROWS||100)+')');
  if(batch.length)await insert(c,'live_stock',id,batch);
  return{rows:count,sourceRows:rows.length,worksheet:name};
}
async function ensureMbqGsvAggregate(client,refreshId){
  await client.query(`CREATE TABLE IF NOT EXISTS public.gsv_mbq_aggregate(
    refresh_id uuid NOT NULL,
    item_id text NOT NULL,
    posting_date date NOT NULL,
    month text NOT NULL,
    cfa text NOT NULL,
    ship_to_code text NOT NULL,
    ship_to_name text NOT NULL DEFAULT '',
    quantity numeric NOT NULL DEFAULT 0,
    amount numeric NOT NULL DEFAULT 0,
    amount_available boolean NOT NULL DEFAULT false,
    row_count integer NOT NULL DEFAULT 0,
    PRIMARY KEY(refresh_id,item_id,posting_date,cfa,ship_to_code)
  )`);
  // Keep only the active candidate refresh. This is transactional with the
  // active-dataset pointer update, so a failed import preserves the old cache.
  await client.query('DELETE FROM public.gsv_mbq_aggregate WHERE refresh_id <> $1',[refreshId]);
  const existing=await client.query('SELECT 1 FROM public.gsv_mbq_aggregate WHERE refresh_id=$1 LIMIT 1',[refreshId]);
  if(existing.rowCount){
    console.log('MBQ GSV aggregate already materialized for refresh '+refreshId);
    return;
  }
  const built=await client.query(`INSERT INTO public.gsv_mbq_aggregate(
    refresh_id,item_id,posting_date,month,cfa,ship_to_code,ship_to_name,
    quantity,amount,amount_available,row_count
  )
  SELECT refresh_id,item_id,posting_date,to_char(posting_date,'YYYY-MM'),
    CASE
      WHEN location_code ~* '\\mALU\\M' THEN 'ALU'
      WHEN location_code ~* '\\mPAY\\M' THEN 'PAY'
      WHEN location_code ~* '\\mTVD\\M' THEN 'TVD'
      ELSE 'ALL'
    END,
    COALESCE(ship_to_code,''),
    COALESCE(MAX(ship_to_name),''),
    SUM(COALESCE(quantity_in_cbo,0))::numeric,
    SUM(COALESCE(amount_to_customer,0))::numeric,
    BOOL_OR(amount_to_customer IS NOT NULL),
    COUNT(*)::integer
  FROM public.gsv_sales
  WHERE refresh_id=$1
    AND item_id IS NOT NULL AND posting_date IS NOT NULL AND quantity_in_cbo IS NOT NULL
  GROUP BY refresh_id,item_id,posting_date,
    CASE
      WHEN location_code ~* '\\mALU\\M' THEN 'ALU'
      WHEN location_code ~* '\\mPAY\\M' THEN 'PAY'
      WHEN location_code ~* '\\mTVD\\M' THEN 'TVD'
      ELSE 'ALL'
    END,
    COALESCE(ship_to_code,'')`,[refreshId]);
  if(!built.rowCount)throw Error('MBQ GSV aggregate materialization returned no rows for refresh '+refreshId);
  console.log('MBQ GSV aggregate materialized:',built.rowCount,'rows');
}
async function main(){
  if(!process.env.SHARED_CACHE_DATABASE_URL)throw Error('Set SHARED_CACHE_DATABASE_URL; existing dashboard DB variables are not used.');
  await fs.promises.mkdir(DIR,{recursive:true});
  const meta=JSON.parse((await get('https://api.github.com/repos/'+REPO+'/releases/latest')).toString());
  const assets=new Map((meta.assets||[]).map(a=>[a.name,a.browser_download_url]));
  const urls=[assets.get(GSV),assets.get(SOH)];
  if(urls.some(x=>!x))throw Error('Both GSV and SOH assets are required in release '+meta.tag_name);
  const files=[path.join(DIR,'gsv.xlsx'),path.join(DIR,'soh.xlsb')];
  console.log('[GITHUB CHECK] Latest release='+meta.tag_name+' | GSV upload='+(meta.assets.find(a=>a.name===GSV)?.created_at||'unknown')+' | LIVE SOH upload='+(meta.assets.find(a=>a.name===SOH)?.created_at||'unknown'));
  console.log('Downloading release '+meta.tag_name);
  const [gm,sm]=await Promise.all([download(urls[0],files[0]),download(urls[1],files[1])]);
  const c=await pool.connect();
  let gid=null,sid=null,lockHeld=false,inFinalTransaction=false;
  const attempted=[];
  c.on('error',e=>console.error('[NEON CLIENT ERROR]',e.message));
  try{
    if(process.env.SHARED_CACHE_REQUIRE_TEST_BRANCH==='true'){
      const guard=await c.query('SELECT marker FROM public.shared_cache_test_guard WHERE id=1');
      if(guard.rows[0]?.marker!=='only-this-test-branch')throw Error('Safety check failed: connection is not the isolated Neon test branch.');
    }
    // A session lock serializes importers without keeping a database transaction
    // open while ExcelJS parses the large workbook and sends individual batches.
    await c.query("SELECT pg_advisory_lock(hashtext('unibic-shared-cache-import'))");
    lockHeld=true;
    await cleanupAbandonedCandidates(c);
    const active=await c.query('SELECT active_gsv_refresh_id,active_live_soh_refresh_id FROM public.cache_active_datasets WHERE singleton=TRUE');
    const old=active.rows[0]||{};
    const prev=await c.query("SELECT id,source_name,file_checksum FROM public.data_refresh_log WHERE refresh_status='active' AND source_name IN ('GSV','LIVE_SOH') ORDER BY started_at DESC");
    const checks=new Map(prev.rows.map(x=>[x.source_name,x.file_checksum]));
    console.log('[CACHE CHECK] GSV='+(checks.get('GSV')===gm.sha?'MATCH - keep existing':'CHANGED - import new')+' | LIVE SOH='+(checks.get('LIVE_SOH')===sm.sha?'MATCH - keep existing':'CHANGED - import new'));
    if(process.env.SHARED_CACHE_FORCE_REIMPORT==='true'||checks.get('GSV')!==gm.sha){
      gid=crypto.randomUUID();
      attempted.push({id:gid,source:'GSV',asset:GSV,sha:gm.sha,bytes:gm.bytes});
      await c.query("INSERT INTO public.data_refresh_log(id,source_name,release_tag,asset_name,file_checksum,file_bytes,refresh_status) VALUES($1,'GSV',$2,$3,$4,$5,'processing')",[gid,meta.tag_name,GSV,gm.sha,gm.bytes]);
      console.log('[GSV IMPORT] started refresh='+gid+' fileBytes='+gm.bytes);
      const n=await importGsv(c,gid,files[0]);
      await c.query("UPDATE public.data_refresh_log SET row_count=$2,refresh_status='validated',completed_at=NOW(),validation_summary=$3::jsonb WHERE id=$1",[gid,n.rows,JSON.stringify({sheet:GSV_SHEET,sha256:gm.sha,...n})]);
      console.log('[GSV IMPORT] validated rows='+n.rows+' sourceRows='+n.sourceRows+' dates='+n.minDate+'..'+n.maxDate);
    }
    if(process.env.SHARED_CACHE_FORCE_REIMPORT==='true'||checks.get('LIVE_SOH')!==sm.sha){
      sid=crypto.randomUUID();
      attempted.push({id:sid,source:'LIVE_SOH',asset:SOH,sha:sm.sha,bytes:sm.bytes});
      await c.query("INSERT INTO public.data_refresh_log(id,source_name,release_tag,asset_name,file_checksum,file_bytes,refresh_status) VALUES($1,'LIVE_SOH',$2,$3,$4,$5,'processing')",[sid,meta.tag_name,SOH,sm.sha,sm.bytes]);
      console.log('[LIVE SOH IMPORT] started refresh='+sid+' fileBytes='+sm.bytes);
      const n=await importSoh(c,sid,files[1]);
      await c.query("UPDATE public.data_refresh_log SET row_count=$2,refresh_status='validated',completed_at=NOW(),validation_summary=$3::jsonb WHERE id=$1",[sid,n.rows,JSON.stringify({sheet:SOH_SHEET,sha256:sm.sha,...n})]);
      console.log('[LIVE SOH IMPORT] validated rows='+n.rows);
    }
    if(gid)await c.query('ANALYZE public.gsv_sales');
    if(sid)await c.query('ANALYZE public.live_stock');
    const ng=gid||old.active_gsv_refresh_id,ns=sid||old.active_live_soh_refresh_id;
    if(!ng||!ns)throw Error('Both data sources must be imported and validated before first activation.');

    // Only the short activation phase is transactional. The active pointers and
    // previous active datasets remain untouched if parsing/import/aggregation fails.
    await c.query('BEGIN');
    inFinalTransaction=true;
    await c.query('SELECT pg_advisory_xact_lock(hashtext(\'unibic-shared-cache-import-activate\'))');
    await c.query('SELECT singleton FROM public.cache_active_datasets WHERE singleton=TRUE FOR UPDATE');
    await ensureMbqGsvAggregate(c,ng);
    await c.query('INSERT INTO public.cache_active_datasets(singleton,active_gsv_refresh_id,active_live_soh_refresh_id,updated_at) VALUES(TRUE,$1,$2,NOW()) ON CONFLICT(singleton) DO UPDATE SET active_gsv_refresh_id=EXCLUDED.active_gsv_refresh_id,active_live_soh_refresh_id=EXCLUDED.active_live_soh_refresh_id,updated_at=NOW()',[ng,ns]);
    if(gid)await c.query("UPDATE public.data_refresh_log SET refresh_status='superseded' WHERE source_name='GSV' AND refresh_status='active' AND id<>$1",[gid]);
    if(sid)await c.query("UPDATE public.data_refresh_log SET refresh_status='superseded' WHERE source_name='LIVE_SOH' AND refresh_status='active' AND id<>$1",[sid]);
    for(const id of [gid,sid].filter(Boolean))await c.query("UPDATE public.data_refresh_log SET refresh_status='active' WHERE id=$1",[id]);
    await c.query('COMMIT');
    inFinalTransaction=false;
    console.log('[NEON CACHE] ACTIVATED | release='+meta.tag_name+' | cacheUpdatedAt='+new Date().toISOString()+' | GSV='+(gid?'UPDATED':'UNCHANGED')+' | LIVE_SOH='+(sid?'UPDATED':'UNCHANGED'));
  }catch(e){
    if(inFinalTransaction)await c.query('ROLLBACK').catch(()=>{});
    // Remove only this failed candidate's rows; never touch the active refresh IDs.
    for(const item of attempted){
      try{
        if(item.source==='GSV'){
          await c.query('DELETE FROM public.gsv_mbq_aggregate WHERE refresh_id=$1',[item.id]);
          await c.query('DELETE FROM public.gsv_sales WHERE refresh_id=$1',[item.id]);
        }else{
          await c.query('DELETE FROM public.live_stock WHERE refresh_id=$1',[item.id]);
        }
        await c.query("UPDATE public.data_refresh_log SET refresh_status='failed',error_message=$2,completed_at=NOW(),validation_summary=$3::jsonb WHERE id=$1",[item.id,String(e.message||e).slice(0,4000),JSON.stringify({stage:'import-or-activation',preservedPreviousActiveCache:true})]);
      }catch(cleanupError){
        console.error('Candidate cleanup failed for '+item.source+':',cleanupError.message);
        await c.query("UPDATE public.data_refresh_log SET refresh_status='failed',error_message=$2,completed_at=NOW(),validation_summary=$3::jsonb WHERE id=$1",[item.id,String(e.message||e).slice(0,4000),JSON.stringify({stage:'cleanup-required',preservedPreviousActiveCache:true})]).catch(()=>{});
      }
    }
    throw e;
  }finally{
    if(lockHeld)await c.query("SELECT pg_advisory_unlock(hashtext('unibic-shared-cache-import'))").catch(e=>console.error('Could not release importer advisory lock:',e.message));
    c.release();
  }
}
main().catch(e=>{console.error('Import failed:',e.stack||e.message);process.exitCode=1;}).finally(()=>pool.end().catch(()=>{}));