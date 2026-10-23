# 결과를 확인하는 순서

1. [진행 현황판](./status.html)을 브라우저에서 연다. [데스크톱 캡처](./status-desktop-2026-10-23.png)만으로도 현재 상태를 볼 수 있다.
2. 현황판의 **설계 화면**에서 단계 탐색·모의 시나리오를 확인한다.
3. **요청 화면**에서 OIDC 로그인→데모 사용자 A→요청 목록·상세를 확인한다. 실제 업무 실행은 아직 연결 전이다. 계정/mock 프로파일의 유효기간과 재시작 방법은 [주기02 안내](./iteration-02/README.md)를 따른다.

현황판은 상태 기준 날짜가 있는 정적 문서다. 제품의 실시간 상태를 조회하지 않는다. 기존 캡처는2026-10-20 KST에 전달된 화면이며 이번에 기존 업무 화면의 기능 검증을 다시 수행한 것은 아니다.

## 현재 개발 서버에서 현황판 열기

2026-10-23 기준 workflow4173만 재기동했고 실제 요청 API8769는 정지 상태다. 현재152 합성 수용은 실제490/업무 실행 수용이 아니다.

이번 전달 주소는 `http://127.0.0.1:4173/ifpmic-progress/delivery/status.html`이다. 기존 Vite preview를 사용하며, 아래 명령으로 현황판과 직접 연결된 공개 문서·이미지만 기존 `dist`에 복사한다. `npm run build`로 `dist`를 다시 만들었다면 이 복사를 다시 수행한다. Node.js24 이상, 저장소 루트 기준이다.

```sh
node --input-type=module <<'JS'
import { readFileSync, mkdirSync, copyFileSync } from 'node:fs';
import path from 'node:path';
const source = path.resolve('docs/ifpmic');
const output = path.resolve('dist/ifpmic-progress');
const page = 'delivery/status.html';
const html = readFileSync(path.join(source, page), 'utf8');
const refs = [...html.matchAll(/(?:href|src)="([^"]+)"/g)]
  .map(match => match[1]).filter(ref => !/^(?:https?:|#)/.test(ref));
const files = new Set([page, ...refs.map(ref => path.normalize(path.join('delivery', ref)))]);
for (const file of files) {
  const input = path.resolve(source, file), target = path.resolve(output, file);
  if (!input.startsWith(source + path.sep) || !target.startsWith(output + path.sep)) throw Error('Invalid path');
  mkdirSync(path.dirname(target), { recursive: true });
  copyFileSync(input, target);
}
console.log(`Copied ${files.size} public status files`);
JS
```

4173 서버가 종료돼 있다면 기존 주기01 안내대로 `node node_modules/vite/bin/vite.js preview --host 127.0.0.1 --port 4173 --strictPort`를 실행한다. 이 현황판을 위해 API/DB/실행 엔진을 시작할 필요는 없다. 다른 기기에서는 개발 환경의 localhost로 직접 접속할 수 없으므로 캡처를 사용한다.

계획과 범위는 [STATUS-PLAN](./STATUS-PLAN.md), 검증 결과는 [status-verification](./status-verification-2026-10-23.json), 검토 결과는 [status-result-review](./status-result-review-2026-10-23.json)를 따른다. 이 전달은 원래16단계의 완료 수를 늘리지 않는다.
