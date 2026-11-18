# time-planner 프로젝트 지침

상위 폴더(`rosedskim/CLAUDE.md`)의 공통 지침도 함께 적용된다. 아래는 이 프로젝트에서 GitHub 이슈를 처리하는 방식이다.

## GitHub 이슈 처리 규칙

- 작업은 **GitHub 이슈 단위**로 하고, **한 번에 이슈 하나**만 처리한다.
- 이슈마다 브랜치를 만든다. 이름은 `issues/{이슈 번호}` (예: 1번 이슈 → `issues/1`). `main`에서 따서 만든다.
- 작업한 내용을 그 브랜치에 commit하고 **push**한다. `main`에는 직접 push하지 않는다.
- push한 `issues/{번호}` 브랜치에서 **`main`으로 PR**을 만든다. PR 본문에 `Closes #{번호}`를 적어 머지 때 이슈가 닫히게 한다.

## 이슈 하나를 처리할 때

1. 기능 개발은 `pstack:poteto-mode`로 진행하고, 만든 내용을 검증한다 (실제 브라우저에서 동작 확인).
2. PR 본문에 아래를 적는다.
   - **처리 내용**: 무엇을 어떻게 바꿨는지
   - **검증**: 무엇을 어떤 방법으로 확인했고 결과가 어땠는지 (확인하지 못한 것도 그대로 적는다)

## 저장소 메모

- 저장소 루트는 `time-planner/`이고, 앱은 하위 폴더에 있다 (현재 `circle-planner/`).
- 작업 메모 파일(`CLAUDE-PROGRESS.txt`, `failure.md`, `feature_list.json`)은 앱 폴더 안에 두며 `.gitignore`로 커밋하지 않는다.
