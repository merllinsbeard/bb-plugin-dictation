#!/usr/bin/env bash
set -euo pipefail
BB=${BB:-bb}
SOURCE=${1:?usage: verify-long.sh <recording at least 27 minutes long> [output-dir]}
OUTPUT=${2:-$PWD/dictation-verification}
mkdir -p "$OUTPUT"
LOCK="$HOME/.cache/dictation-verify.lock"
mkdir -p "$(dirname "$LOCK")"
exec 9>>"$LOCK"
flock -n 9 || { echo 'Another dictation verification is running.' >&2; exit 1; }
WORK=$(mktemp -d)
"$BB" settings ai-services --json > "$WORK/before.json"
cp "$WORK/before.json" "$OUTPUT/selection-before.json"
restore() {
  local status=$?
  trap - EXIT INT TERM
  if ! python3 - "$BB" "$WORK/before.json" <<'PY'
import json,subprocess,sys
selection=json.load(open(sys.argv[2]))['selections']['voice']
args=[sys.argv[1],'settings','ai-services','set','voice']
args += [selection['serviceId'],'--plugin',selection['pluginId']] if selection['mode']=='service' else [selection['mode']]
subprocess.run(args,check=True,stdout=subprocess.DEVNULL)
PY
  then status=1; fi
  "$BB" settings ai-services --json > "$OUTPUT/selection-after.json"
  if ! python3 - "$OUTPUT/selection-before.json" "$OUTPUT/selection-after.json" <<'PY'
import json,sys
before,after=(json.load(open(p))['selections']['voice'] for p in sys.argv[1:])
if before != after: raise SystemExit('ERROR: voice selection was not restored')
print('Original voice selection restored: '+json.dumps(after))
PY
  then status=1; fi
  rm -rf "$WORK"
  exit "$status"
}
trap restore EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
python3 - "$BB" "$SOURCE" "$OUTPUT" "$WORK" <<'PY'
import json,os,pathlib,subprocess,sys,time
bb,source,output,work=sys.argv[1:]
output=pathlib.Path(output)
metrics_path=output/'metrics.json'
metrics=json.loads(metrics_path.read_text()) if metrics_path.exists() else {}
cases=[('1m',1,160,True),('5m',5,160,True),('10m',10,160,True),('17m',17,160,True),('25m',25,128,True),('overflow',25,160,False)]
selected=os.environ.get('DICTATION_CASES')
if selected:
    names=selected.split(',')
    if set(names)-{c[0] for c in cases}: raise SystemExit('Unknown DICTATION_CASES')
    cases=[c for c in cases if c[0] in names]

def save():
    table=['| Clip | MiB | OpenRouter s | words | ChatGPT s | words | delta | Result |','|---|---:|---:|---:|---:|---:|---:|---|']
    endings=[]
    for entry in metrics.values():
        a,b=(entry['services'].get(service,{}) for service in ['openrouter','chatgpt'])
        delta=f"{abs(a['words']-b['words'])/a['words']*100:.2f}%" if entry['passing'] and a.get('words') and b.get('words') else 'n/a'
        table.append(f"| {entry['minutes']}m {entry['bitrate']}k | {entry['bytes']/1024/1024:.2f} | {a.get('seconds','n/a')} | {a.get('words','n/a')} | {b.get('seconds','n/a')} | {b.get('words','n/a')} | {delta} | {entry['result']} |")
        for service,value in entry['services'].items():
            if value.get('ending'): endings.append(f"{entry['minutes']}m {entry['bitrate']}k {service}: {value['ending']}")
    metrics_path.write_text(json.dumps(metrics,indent=2)+'\n')
    (output/'table.md').write_text('\n'.join(table)+'\n')
    (output/'endings.txt').write_text('\n'.join(endings)+'\n')

failed=False
for name,minutes,bitrate,passing in cases:
    clip=pathlib.Path(work)/f'{minutes}m-{bitrate}k.webm'
    subprocess.run(['ffmpeg','-nostdin','-v','error','-ss','120','-i',source,'-t',str(minutes*60),'-vn','-c:a','libopus','-b:a',f'{bitrate}k','-f','webm','-live','1',str(clip)],check=True)
    size=clip.stat().st_size
    entry={'minutes':minutes,'bitrate':bitrate,'bytes':size,'passing':passing,'services':{},'result':'RUNNING'}
    metrics[name]=entry
    if (size<=25*1024*1024) != passing:
        entry['result']='FAIL: fixture size'
        failed=True
        save()
        print(f"{minutes}m {bitrate}k: {size} bytes, incompatible with expected core size rejection",flush=True)
        clip.unlink()
        continue
    for service in ['openrouter','chatgpt']:
        subprocess.run([bb,'settings','ai-services','set','voice',service,'--plugin','dictation'],check=True,stdout=subprocess.DEVNULL)
        start=time.monotonic()
        result=subprocess.run([bb,'voice','transcribe',str(clip),'--json'],text=True,capture_output=True)
        elapsed=round(time.monotonic()-start,2)
        (output/f'{minutes}m-{bitrate}k-{service}.json').write_text(result.stdout)
        (output/f'{minutes}m-{bitrate}k-{service}.stderr').write_text(result.stderr)
        text=''
        ok=False
        if passing and result.returncode==0:
            try: text=json.loads(result.stdout)['text']; ok=bool(text.strip()) and elapsed<64
            except (ValueError,KeyError,TypeError): pass
        if not passing:
            ok=result.returncode!=0 and '25MB limit' in result.stdout+result.stderr
        entry['services'][service]={'seconds':elapsed,'words':len(text.split()),'ok':ok,'ending':' '.join(text.split()[-40:])}
        save()
        print(f"{minutes}m {bitrate}k {service}: {elapsed:.2f}s, {len(text.split())} words, "+('PASS' if ok else 'FAIL'),flush=True)
    a,b=(entry['services'][service] for service in ['openrouter','chatgpt'])
    delta=abs(a['words']-b['words'])/max(1,a['words'])*100 if passing else 0
    ok=a['ok'] and b['ok'] and (not passing or delta<=3)
    failed=failed or not ok
    entry['result']='PASS' if passing and ok else 'REJECTED (size)' if ok else 'FAIL'
    save()
    clip.unlink()
print((output/'table.md').read_text(),flush=True)
print('Compare transcript endings in '+str(output/'endings.txt')+'.',flush=True)
raise SystemExit(1 if failed else 0)
PY
