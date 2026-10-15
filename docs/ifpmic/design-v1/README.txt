IFPMIC AX Design v1

설계서: IFPMIC_AX_Design_v1.docx
계약 파일: specs/
설계 검증 결과: qa/design-validation.json
검증 도구: verify_design.py

이 패키지는 설계 산출물입니다. 실제 서비스와 사내 도구 연동은 구현 백로그에 따라 진행해야 합니다.
project-profile.example.json은 실제 환경값이 없어 비활성 mock 상태입니다.
원본 첨부 문서는 변경하지 않았습니다.

계약 재검증 방법
Python 3.10 이상에서 python -m pip install -r validation-requirements.txt 실행 후 python verify_design.py 실행. 실제 서비스에 대한 테스트가 아닌 설계 구조 검사입니다.

설계서 21쪽을 렌더링하여 표와 페이지를 확인했습니다. 사내 연동은 specs/project-profile.example.json의 CONFIGURE 값을 실제 값으로 채운 뒤 별도 검증해야 합니다.
