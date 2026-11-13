# Curriculum records

The official CKA and CKAD curricula the content is built against. `npm run update:check`
(phase 33) compares these records with the current official ones.

| | CKA | CKAD |
|---|---|---|
| Document | `CKA_Curriculum_v1.37.pdf` | `CKAD_Curriculum_v1.37.pdf` |
| Curriculum version | v1.37 | v1.37 |
| URL | <https://github.com/cncf/curriculum/blob/main/CKA_Curriculum_v1.37.pdf> | <https://github.com/cncf/curriculum/blob/main/CKAD_Curriculum_v1.37.pdf> |
| SHA-256 | `634b793704485c2ac424a90902e0f8b28f7348a49814393434f808e3e78ec18c` | `7736d2f0291239d62e9fc618304413ee9b6e53fc4580aac70bf4328203c1c210` |
| Git blob SHA | `7732bda869493f67ae13705b6e8a0b79831e3541` | `64b0a75980923921ec5b0ecc54fceaaea3ef5a3e` |
| Exam page | <https://training.linuxfoundation.org/certification/certified-kubernetes-administrator-cka/> | <https://training.linuxfoundation.org/certification/certified-kubernetes-application-developer-ckad/> |
| Exam page says | "The exam is based on Kubernetes v1.37." | "The exam is based on Kubernetes v1.37." |

- Date checked: 2026-11-13.
- Repository: <https://github.com/cncf/curriculum>, `main` at commit
  `f5ab45e0ed85cb38a23252a71eb05891e513da66` (2026-11-12).
- License: the repository README states "The Curriculum is available under the CC-BY 4.0+
  License" (<https://creativecommons.org/licenses/by/4.0/>). The PDFs are therefore kept here
  unmodified, with this attribution: © Cloud Native Computing Foundation, CC BY 4.0.

## Files

- `competencies.yaml` — every competency of both exams with a stable id and the official wording.
  Content items reference these ids in their `curriculum` field (`docs/SCENARIO_FORMAT.md`).
  The curriculum map of phase 14 builds on this file.
- `cka.md`, `ckad.md` — the competency lists as text, extracted from the PDFs with `pdftotext`.

## Differences between the PDF and the exam page

The exam pages and the PDFs agree on every competency. They differ in spelling only, and
`competencies.yaml` uses the PDF wording, with these notes:

- CKA: the PDF heading reads "Servicing and Networking"; the exam page reads "Services &
  Networking". The PDF writes "and" where the page writes "&" in two other domain names.
- CKAD: the PDF reads "Understand API depreciations"; the exam page reads "Understand API
  deprecations". The id uses `api-deprecations`.
- CKAD: the PDF lists "Define resource requirements" before "Understand ConfigMaps"; the page
  lists them the other way round.
