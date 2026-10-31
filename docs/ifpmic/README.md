# IFPMIC AX 기준 자료와 이관 계획

현재 폴더의 AX 구현과 보존된 실행 기록을 기반 자료로 사용한다. 실제 AX 에이전트 workflow와 역할별 지침 파일, 검토할 산출물과 시연을 제공한다. Paperclip은 과거 참고 자료이자 선택 가능한 관제 호스트다. 최종 업무 규칙은 제공된 IFPMIC 설계 패키지를 따른다.

현재 개발 순서는 [애자일 전달 계획](./AGILE-DELIVERY.md), [전달 기준 데이터](./delivery-plan.json), [접수 연결 V4](./delivery/iteration-03/ADMISSION-UI-PLAN-v4.md)를 따른다. 과거 후보의 구현·실행 금지 체크포인트는 당시 이력이며, 현재의 좁은 개발/격리 통합과 전체 수용을 구분한다. 원본 계약과 최종 인수 기준은 유지한다. 최신 진행 화면은 `/delivery.html`이다.

| 구분 | 기준 | 사용 방법 |
|---|---|---|
| 기반 자료 | 현재 AX 소스, README, `experiments/paperclip/` 및 실행 증거 | 기록 읽기, 상태 표현, 격리, 복구와 검증 경험 재사용 |
| 선택적 관제 호스트 참고 자료 | [Paperclip](https://github.com/paperclipai/paperclip) | 과거 작업·조직·실행 이력 화면과 adapter 구조 참고. 필수 실행 의존성이 아님 |
| 최종 목표 | `IFPMIC_AX_Design_Package_v1.zip`, `IFPMIC_AX_Design_v1.docx` | 6개 역할, 사람 작업, 품질 gate, 장비, 승인 및 배포를 연결 |

- [Paperclip 조사와 적용 범위](./PAPERCLIP.md)
- [시각화와 단계별 이관 계획](./PLAN.md)
- [단계별 검증 계획](./VERIFICATION.md)과 [독립 검토](./evidence/plan-review.json)
- [진행 상태](./progress.json)와 [결정·실패 복구 이력](./DECISIONS.md)
- [원본 설계 계약](./design-v1/README.txt)
- [자료 해시와 출처](./source-manifest.json)

`design-v1/`은 ZIP의 JSON 계약, 검증 도구와 QA 보고서를 바이트 그대로 보존한 참조 자료다. 제품 실행 코드가 아니며, `project-profile.example.json`은 `enabled=false`, `mode=mock`이다. 원본 ZIP과 DOCX는 저장소 루트의 제공 파일을 읽었으며 이 변경의 커밋 대상에서 제외한다. 별도 DOCX와 ZIP 내부 DOCX의 SHA-256은 일치한다.

설계 구조 검증은 임시 복사본에서 다음과 같이 재현한다. `validation-requirements.txt`의 Python 의존성이 필요하며, 실행 시 해당 복사본의 `qa/design-validation.json`이 갱신된다.

```sh
AX_DESIGN_CHECK_DIR=$(mktemp -d /tmp/ifpmic-design-check.XXXXXX)
cp -R docs/ifpmic/design-v1 "$AX_DESIGN_CHECK_DIR/design-v1"
python3 "$AX_DESIGN_CHECK_DIR/design-v1/verify_design.py"
```

2026년 10월 15일 과거 검토에서는 정적 설계 검사 53/53이 통과했다. 수용시험 32건은 모두 `not_executed`이며 실제 시스템 통과 결과와 구분한다. 당시 Paperclip page/plugin 및 호스트 장착 결과는 그 시점의 화면 검증 증거로 보존한다. 현재 첫 에이전트 pilot은 로컬 Codex CLI adapter로 P01/P02 분석 산출물을 만들고 검토하는 범위이며 P03 전에 멈춘다. 이는 IFPMIC job/gate 완료나 업무 전이가 아니다. 현재 순서는 [애자일 전달 계획](./AGILE-DELIVERY.md)과 [이관 계획](./PLAN.md)을 따른다.
