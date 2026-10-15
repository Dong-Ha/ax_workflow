# Native host 안내 영역의 캡처 처리

`V2-EXCEPTION-UI.md` U2/U3의 API 쓰기 0 기준을 유지하는 캡처 절차다. 첫 진단에서 부모가 안내 닫기를 브라우저 로컬 동작으로 잘못 판단했으며, Paperclip의 안내 닫기 버튼은 실제 `/api/announcements/2026-09-14-connectors/dismiss` POST를 보냈다. 이 진단은 실패이며 최종 후보 수용 증거가 아니다. 해당 요청의 재전송·서버 상태 복원 쓰기는 하지 않는다.

최종 TC는 닫기 버튼을 누르거나 POST를 예외적으로 허용·모킹·집계 제외하지 않는다. 격리된 브라우저의 `aside[aria-label="Paperclip announcements"]`가 있으면 정확히 하나인지, 실제 텍스트가 Introducing Connectors 및 Give your agents the access they need 안내인지, IFPMIC 요소를 포함하지 않는지 확인한다. 그 안내 영역에만 `visibility:hidden`을 적용하고 selector·실제 관측 문구·action·count를 captureAdjustments에 기록한다. 안내가 없으면 아무 DOM/서버 변경도 하지 않으며 없음도 기록한다. standalone에는 이 조정을 하지 않는다.

이 조정은 workflow 모델·controls·데이터·레이아웃·host 영속 설정을 변경하지 않으며 API 쓰기/외부 요청/runtime 오류 0 검사도 유지한다. 대표 패널 캡처 직전 center scroll은 필드를 host header 밖으로 보이게 하는 탐색이다. 제품 UI를 대신 그리거나 snapshot 결과를 수정하지 않는다. 잔여 한계는 이 증거가 Paperclip 자체 안내 기능의 동작/시각 검증을 입증하지 않는다는 점이다. IFPMIC 새 패널과 workflow의 검증 범위는 축소하지 않는다.

독립 검토자는 이 절차와 TC의 실제 selector/identity assertion, write0 기준, capture ledger를 후보 고정 전에 확인하고, 고정 gate의 두 browser 결과에서 조정 기록 및 쓰기 0을 다시 감사한다. 실패하면 첫 잘못된 DOM 선택/요청부터 수정하고 U2/U3를 재검증한다.
