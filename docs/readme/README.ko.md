<div align="center">

<h1>
  <img src="../assets/wordmark.svg#gh-light-mode-only" width="280" height="88" alt="Papilot">
  <img src="../assets/wordmark-dark.svg#gh-dark-mode-only" width="280" height="88" alt="Papilot">
</h1>

<p><b>AI로 LaTeX 논문을 수정하고, PDF에서 변경 사항을 검토하세요.</b></p>

<p><a href="https://papilot.ai">웹사이트</a> · <a href="../guide.md">문서</a></p>

<p data-language-switcher><a href="../../README.md">English</a> · <a href="README.zh-CN.md">简体中文</a> · <a href="README.zh-Hant.md">繁體中文</a> · <a href="README.ja.md">日本語</a> · <a href="README.ko.md">한국어</a> · <a href="README.de.md">Deutsch</a> · <a href="README.fr.md">Français</a> · <a href="README.es.md">Español</a> · <a href="README.pt.md">Português</a> · <a href="README.it.md">Italiano</a> · <a href="README.sv.md">Svenska</a></p>

[![CI](https://github.com/PapilotAI/papilot/actions/workflows/ci.yml/badge.svg)](https://github.com/PapilotAI/papilot/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/papilot?color=2563eb&logo=npm)](https://www.npmjs.com/package/papilot)
[![License: MIT](https://img.shields.io/badge/license-MIT-2563eb)](../../LICENSE)

<p><img src="../assets/demo.gif" alt="Papilot: PDF의 구절을 표시해 에이전트에게 전달하고 조판된 변경 사항을 검토" width="100%"></p>

</div>

Papilot은 AI 에이전트와 함께 LaTeX 논문을 작성하고 수정하기 위한 로컬 워크스페이스입니다. PDF에서 구절과 수식을 표시해 에이전트가 별도의 소스 사본을 편집하도록 한 다음, 조판된 변경 사항을 검토하고 반영할 항목을 선택하세요.

<a id="features"></a>

## 기능

<table>
<tr>
<td width="50%" valign="top">
<a href="../assets/readme-note.jpg"><img src="../assets/readme-note.jpg" alt="PDF에 색상별로 묶인 구절 주석과 상자로 지정된 수식 주석"></a>
<h3>PDF에 주석 달기</h3>
문장을 선택하거나 수식을 상자로 지정하고 수정할 내용을 입력하세요. 관련된 주석을 색상별로 묶어 여러 구절에 하나의 지시를 내릴 수 있습니다.
</td>
<td width="50%" valign="top">
<a href="../assets/readme-review.jpg"><img src="../assets/readme-review.jpg" alt="수락, 거절, 댓글 버튼이 있는 페이지의 변경 전후 조판 비교"></a>
<h3>각 변경 사항 검토</h3>
수식 번호 재지정 등 다른 위치의 변경 사항을 포함해 조판된 페이지의 변경 전후를 비교하세요. 각 편집 내용을 수락하거나 거절하고 댓글을 남길 수 있으며, 검토 중에 결정을 실행 취소할 수도 있습니다.
</td>
</tr>
<tr>
<td width="50%" valign="top">
<a href="../assets/readme-deliver.jpg"><img src="../assets/readme-deliver.jpg" alt="수락한 편집 내용을 원고에 적용"></a>
<h3>편집 내용 반영 방식 선택</h3>
새로운 각 작업은 논문의 독립된 사본에서 진행됩니다. 편집 내용을 검토한 후 **원고에 커밋**을 선택해 이 작업을 현재 브랜치의 단일 커밋으로 저장하거나, **워크스페이스에 적용**을 선택해 커밋하지 않은 상태로 편집 내용을 반영하세요. 그사이에 동일한 구절이 변경된 경우 AI가 자동으로 충돌을 해결하며, 의도한 내용이 불분명할 때만 사용자에게 확인을 요청합니다. 저장하기 전에 병합된 PDF를 검토하세요. 준비가 되면 Git 패널에서 푸시할 수 있습니다.
</td>
<td width="50%" valign="top">
<a href="../assets/readme-git.jpg"><img src="../assets/readme-git.jpg" alt="스테이징된 파일, 생성된 커밋 메시지, 커밋 그래프가 표시된 Git 패널"></a>
<h3>Git으로 작업</h3>
워크스페이스에서 파일을 스테이징 및 커밋하고 풀과 푸시를 수행하세요. 에이전트가 커밋 메시지 초안을 작성하고 병합 충돌 해결을 도울 수 있으며, 커밋 그래프에는 각 작업의 작업 트리가 표시됩니다.
</td>
</tr>
</table>

- **[스킬](../guide.md#skills) 및 [첨부 파일](../guide.md#task-attachments):** `/` 스킬을 실행해 문장을 다듬거나 교정하고 수식을 점검할 수 있으며, 설정에서 사용자 지정 스킬을 정의하고 작업 및 메시지에 참고 파일이나 이미지를 첨부할 수 있습니다.
- **열람 및 워크스페이스:** PDF 목차와 전체 텍스트 검색으로 원고를 탐색할 수 있으며, 라이트 및 다크 테마와 영어 또는 중국어 인터페이스를 지원합니다.

<a id="quick-start"></a>

## 빠른 시작

macOS 및 Linux 데스크톱 앱과 로컬 빌드 방법은 [Papilot Desktop](../../desktop/README.md)을 참고하세요. 데스크톱 CI는 Apple Silicon 및 Intel Mac 설치 프로그램과 Linux x64용 AppImage 및 deb 패키지를 빌드합니다.

Papilot을 사용하려면 **Node.js 22.22+**, **Git**, 그리고 `latexmk`와 `synctex`가 포함된 전체 **TeX** 배포판([MacTeX](https://www.tug.org/mactex/) 또는 [TeX Live](https://www.tug.org/texlive/))이 필요합니다. 논문을 수정하려면 구성된 [에이전트](#agents)도 최소 하나 이상 필요합니다.

```sh
npm install -g papilot
papilot demo
```

[http://127.0.0.1:7274](http://127.0.0.1:7274)를 열고 사이드바에서 **원고**를 선택해 기본 제공되는 예제 논문을 살펴보세요.

직접 작성한 원고로 작업하려면 `papilot`을 실행하고 **논문 추가…**를 선택해 로컬 LaTeX 폴더나 ZIP 압축 파일을 여세요. Papilot은 메인 `.tex` 파일을 찾고, 필요한 경우 Git 기록을 준비한 뒤 컴파일을 시도합니다. 메인 파일이 불분명하거나 빌드에 실패하면 가져오기 대화상자를 통해 파일을 선택하거나 문제를 해결할 수 있습니다.

**설정 → 런타임**의 **에이전트** 또는 **LaTeX** 항목에서 설정 상태를 확인하세요. `papilot doctor`를 실행해 환경을 점검하거나, `papilot doctor --repo /path/to/paper`를 실행해 원고도 함께 점검할 수 있습니다([진단](../guide.md#diagnostics)).

<a id="agents"></a>

## 에이전트

<!-- BEGIN AGENT ICONS -->
<p align="center">
  <a href="../guide.md#agents">
    <picture>
      <source media="(prefers-color-scheme: dark) and (max-width: 600px)" srcset="../assets/readme-agents/compact-dark.svg">
      <source media="(prefers-color-scheme: dark)" srcset="../assets/readme-agents/desktop-dark.svg">
      <source media="(max-width: 600px)" srcset="../assets/readme-agents/compact.svg">
      <img src="../assets/readme-agents/desktop.svg" alt="Codex, Claude, Cursor, Copilot, Grok, Antigravity, Kimi, GLM, DeepSeek, Qwen, OpenCode" width="816">
    </picture>
  </a>
</p>
<!-- END AGENT ICONS -->

각 작업마다 에이전트와 모델을 선택할 수 있습니다. 연동 방식에 따라 Papilot은 로컬 CLI 로그인 정보나 사용자가 제공한 제공자 API 자격 증명을 사용해 에이전트를 실행하며, 키를 별도로 저장하지 않습니다.

**설정 → 런타임 → 에이전트**를 열어 상태, 모델 및 설정 방법(예: `papilot codex login`)을 확인하세요. Papilot 실행 중에 에이전트를 설치하거나 로그인한 경우 **다시 연결**을 클릭하고, 환경 변수를 변경한 경우에는 `papilot`을 재시작하세요. 에이전트별 요구 사항과 기능은 [에이전트 가이드](../guide.md#agents)를 참고하세요.

<a id="documentation-and-community"></a>

## 문서 및 커뮤니티

- **문서:** 워크스페이스 워크플로, 구성, [앱 내 업데이트](../guide.md#updates), [Tailscale을 이용한 원격 액세스](../guide.md#remote-access-with-tailscale), [공동 작업자를 위한 패스키 공유](../guide.md#collaborators)에 관한 자세한 내용은 [사용자 가이드](../guide.md)를 참고하세요.
- **설계 및 변경 기록:** 공식 설계 논문과 증명은 [`examples/papilot-paper`](../../examples/papilot-paper)에서 살펴보고, 릴리스 노트는 [변경 로그](../../CHANGELOG.md)에서 확인하세요.
- **커뮤니티 및 지원:** [Discussions](https://github.com/PapilotAI/papilot/discussions)에서 질문하거나, [Issues](https://github.com/PapilotAI/papilot/issues)에서 버그를 제보하고, [CONTRIBUTING.md](../../.github/CONTRIBUTING.md)를 읽고 프로젝트에 기여해 보세요.

---

[MIT](../../LICENSE) © 2026 PapilotAI

파트너: [LINUX DO](https://linux.do/).
