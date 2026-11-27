"""Short-lived, offline Chinese/English OCR worker. Adds invisible text to a copy."""
import json,os,sys
from pathlib import Path

def run(source,destination,progress):
    try:
        import fitz,numpy as np
        from rapidocr_onnxruntime import RapidOCR
    except ImportError:raise RuntimeError('本地 OCR 组件未安装，请安装 requirements-reading.txt 中的可选依赖') from None
    engine=RapidOCR(intra_op_num_threads=2,inter_op_num_threads=1)
    doc=fitz.open(source)
    if doc.needs_pass:raise ValueError('PDF 受密码保护')
    font=fitz.Font('cjk');recognized=0
    for index,page in enumerate(doc):
        rotation=page.rotation
        if rotation:page.set_rotation(0)
        text=page.get_text().strip()
        image_area=sum(rect.get_area() for image in page.get_images() for rect in page.get_image_rects(image[0]))
        if len(text)<40 or (len(text)<400 and image_area>page.rect.get_area()*.7):
            scale=min(2.0,2400/max(page.rect.width,page.rect.height));pix=page.get_pixmap(matrix=fitz.Matrix(scale,scale),alpha=False)
            image=np.frombuffer(pix.samples,dtype=np.uint8).reshape(pix.height,pix.width,pix.n)
            rows,_=engine(image)
            for box,content,score in rows or []:
                if not content.strip() or score<.35:continue
                x=min(p[0] for p in box)/scale;y=min(p[1] for p in box)/scale;w=(max(p[0] for p in box)-min(p[0] for p in box))/scale;h=(max(p[1] for p in box)-min(p[1] for p in box))/scale
                size=max(3,h*.8);point=fitz.Point(x,y+size);writer=fitz.TextWriter(page.rect);writer.append(point,content,font=font,fontsize=size)
                width=font.text_length(content,fontsize=size);morph=(point,fitz.Matrix(min(1,w/max(width,1)),1))
                writer.write_text(page,render_mode=3,morph=morph);recognized+=1
            del image,pix
        if rotation:page.set_rotation(rotation)
        temp=Path(str(progress)+'.tmp');temp.write_text(json.dumps({'processed':index+1,'total':len(doc),'message':f'本地识别 {index+1}/{len(doc)} 页'},ensure_ascii=False),'utf-8');os.replace(temp,progress)
    if not recognized and not any(p.get_text().strip() for p in doc):raise ValueError('没有识别出文字，请检查扫描清晰度')
    doc.subset_fonts();doc.save(destination,garbage=4,deflate=True);doc.close()

if __name__=='__main__':run(*map(Path,sys.argv[1:4]))
