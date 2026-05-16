// PR-V Phase 3.26 — Attachment handling (file/photo upload + preview + processing).
// Extracted from chat.html inline <script> (was lines 2512-2574).
//
// Flow: user clicks the paperclip → onFilesSelected reads the file
// via FileReader → renders a thumbnail preview chip in attach-preview
// strip. On Enter, processAttachments(userText) is called from sendMsg
// to convert images to a vision-input format and read text files via
// H.readUploadedFile, then bundles them into the prompt context.
//
// Fns:
//   onFilesSelected(e) — file input change handler
//   renderAttachPreview() — render the preview strip
//   processAttachments(userText) — convert to provider-ready context

// -- File/Photo upload handling ------------------------------------------------
function onFilesSelected(e){
  const files=[...e.target.files];
  e.target.value=''; // reset so same file can be re-selected
  files.forEach(file=>{
    const reader=new FileReader();
    reader.onload=ev=>{
      const b64=ev.target.result.split(',')[1];
      const isImage=file.type.startsWith('image/');
      const att={name:file.name, type:file.type||'application/octet-stream', base64:b64, isImage};
      attachments.push(att);
      renderAttachPreview();
      document.getElementById('btn-send').disabled=false;
    };
    reader.readAsDataURL(file);
  });
}

function renderAttachPreview(){
  const area=document.getElementById('attach-preview');
  area.innerHTML='';
  attachments.forEach((att,i)=>{
    if(att.isImage){
      const img=document.createElement('img');
      img.className='att-img';
      img.src=`data:${att.type};base64,${att.base64}`;
      img.title=att.name;
      const wrap=document.createElement('div');
      wrap.style.position='relative';
      const rm=document.createElement('button');
      rm.textContent='×'; rm.style.cssText='position:absolute;top:-4px;right:-4px;background:var(--bg3);border:1px solid var(--b1);border-radius:50%;width:16px;height:16px;font-size:10px;cursor:pointer;color:var(--t2);display:flex;align-items:center;justify-content:center;padding:0;z-index:1';
      rm.onclick=()=>{attachments.splice(i,1);renderAttachPreview();};
      wrap.appendChild(img); wrap.appendChild(rm);
      area.appendChild(wrap);
    } else {
      const chip=document.createElement('div');
      chip.className='att-chip';
      const icon = att.name.endsWith('.zip')?'📦': att.name.endsWith('.pdf')?'📄': att.name.match(/\.(js|ts|py|html|css|json)$/)?'💻': '📝';
      chip.innerHTML=`<span>${icon}</span><span title="${att.name}">${att.name}</span><button onclick="attachments.splice(${i},1);renderAttachPreview()">×</button>`;
      area.appendChild(chip);
    }
  });
}

async function processAttachments(userText){
  if(!attachments.length) return null;
  const results=[];
  for(const att of attachments){
    if(att.isImage){
      setStatus(lang==='ru'?'🔍 Анализирую изображение…':'🔍 Analyzing image…',true);
      const q = userText && userText.length>2 ? userText : null;
      const r=await H.analyzeImage(att.base64, att.type, q);
      if(r.reply) results.push({type:'image',name:att.name,analysis:r.reply,model:r.model,base64:att.base64,mimeType:att.type});
      else results.push({type:'image',name:att.name,error:r.error});
    } else {
      setStatus(lang==='ru'?`📂 Читаю ${att.name}…`:`📂 Reading ${att.name}…`,true);
      const r=await H.readUploadedFile(att.base64, att.name, att.type);
      if(r.ok) results.push({type:'file',name:att.name,content:r.content,ext:r.ext});
      else results.push({type:'file',name:att.name,error:r.error});
    }
  }
  return results;
}


