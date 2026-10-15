# IFPMIC AX 기준 자료와 이관 계획

현재 폴더의 AX 구현과 실행 기록을 기반 자료로 사용하고, Paperclip을 업무 관제 플랫폼으로 활용하여 IFPMIC 설계서의 workflow를 시각화한다. 최종 업무 규칙은 제공된 IFPMIC 설계 패키지를 따른다.

| 구분 | 기준 | 사용 방법 |
|---|---|---|
| 기반 자료 | 현재 AX 소스, README, `experiments/paperclip/` 및 실행 증거 | 기록 읽기, 상태 표현, 격리, 복구와 검증 경험 재사용 |
| 참고 오픈소스 | [Paperclip](https://github.com/paperclipai/paperclip) | 작업·조직·실행 이력 UI와 adapter 구조 활용 |
| 최종 목표 | `IFPMIC_AX_Design_Package_v1.zip`, `IFPMIC_AX_Design_v1.docx` | 6개 역할, 사람 작업, 품질 gate, 장비, 승인 및 배포를 연결 |

- [Paperclip 조사와 적용 범위](./PAPERCLIP.md)
- [시각화와 단계별 이관 계획](./PLAN.md)
- [원본 설계 계약](./design-v1/README.txt)
- [자료 해시와 출처](./source-manifest.json)

`design-v1/`은 ZIP의 JSON 계약, 검증 도구와 QA 보고서를 바이트 그대로 보존한 참조 자료다. 제품 실행 코드가 아니며, `project-profile.example.json`은 `enabled=false`, `mode=mock`이다. 원본 ZIP과 DOCX는 저장소 루트의 제공 파일을 읽었으며 이 변경의 커밋 대상에서 제외한다. 별도 DOCX와 ZIP 내부 DOCX의 SHA-256은 일치한다.

설계 구조 검증은 임시 복사본에서 다음과 같이 재현한다. `validation-requirements.txt`의 Python 의존성이 필요하며, 실행 시 해당 복사본의 `qa/design-validation.json`이 갱신된다.

```sh
AX_DESIGN_CHECK_DIR=$(mktemp -d /tmp/ifpmic-design-check.XXXXXX)
cp -R docs/ifpmic/design-v1 "$AX_DESIGN_CHECK_DIR/design-v1"
python3 "$AX_DESIGN_CHECK_DIR/design-v1/verify_design.py"
```

2026년 10월 15일 검토에서 정적 설계 검사 53/53이 통과했다. 수용시험 32건은 모두 `not_executed`이며 실제 시스템 통과 결과와 구분한다. 이번 변경은 조사, 계약 보존, 이관 계획까지이며 제품 실행이나 IFPMIC 화면 구현을 완료한 상태는 아니다.
