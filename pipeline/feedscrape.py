import json,sys,time,asyncio,re
from playwright.async_api import async_playwright
SORT=sys.argv[1] if len(sys.argv)>1 else 'popular'
PAGES=int(sys.argv[2]) if len(sys.argv)>2 else 8
async def main():
    got=[]
    async with async_playwright() as p:
        b=await p.chromium.launch(channel='chrome',headless=True,args=['--disable-blink-features=AutomationControlled'])
        ctx=await b.new_context(user_agent='Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36')
        page=await ctx.new_page()
        async def on_resp(r):
            if '/builds/' in r.url and r.request.method=='GET':
                try:
                    j=await r.json(); got.append(j); print('resp',r.status,r.url[:120],'n=',len(j.get('builds',[])),file=sys.stderr)
                except Exception as e: print('resp-err',r.status,r.url[:100],e,file=sys.stderr)
        page.on('response',on_resp)
        await page.goto('https://deepwoken.co/feed',wait_until='domcontentloaded',timeout=60000); await page.wait_for_timeout(6000)
        # click sort button by label
        label={'popular':'Most viewed','top':'Top rated','newest':'Newest'}[SORT]
        try:
            await page.get_by_text(label,exact=True).first.click(timeout=10000)
        except Exception as e: print('sort click fail',e,file=sys.stderr)
        await page.wait_for_timeout(3000)
        for i in range(PAGES):
            btns=page.get_by_role('button',name=re.compile('load|more',re.I))
            try:
                await page.mouse.wheel(0,20000); await page.wait_for_timeout(800)
                await btns.first.click(timeout=5000)
            except Exception as e:
                print('no more button at page',i,file=sys.stderr); 
                await page.mouse.wheel(0,20000)
            await page.wait_for_timeout(2500)
        html=await page.content(); open(f'feed_{SORT}_rendered.html','w',encoding='utf-8').write(html)
        await b.close()
    builds={}
    for j in got:
        for bb in j.get('builds',[]): builds[bb['id']]=bb
    json.dump(list(builds.values()),open(f'feed_{SORT}.json','w'),indent=1)
    print('total builds',len(builds))
asyncio.run(main())
