Fixture repositories under */repos/ store their workflow directory as `dot-github/`
instead of `.github/` so repository-wide workflow scanners do not treat test fixtures
as real workflows (composite actions likewise store `action.yml` as `action.yml.fixture`). Tests materialise a fixture into a temp directory and rename
`dot-github` to `.github` via test/helpers/fixture-repo.ts before running the checker.
