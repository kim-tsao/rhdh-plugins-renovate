# @red-hat-developer-hub/backstage-plugin-orchestrator-form-api

## 1.4.3

### Patch Changes

- d59e940: Updated dependency `@openapitools/openapi-generator-cli` to `2.15.3`.
  Updated dependency `prettier` to `3.4.2`.
  Updated dependency `@janus-idp/cli` to `1.19.1`.
  Updated dependency `monaco-editor` to `0.52.2`.
  Updated dependency `monaco-yaml` to `5.2.3`.
  Updated dependency `sass` to `1.83.0`.
  Updated dependency `webpack` to `5.97.1`.

## 1.4.2

### Patch Changes

- 54daa8c: Migrated from [janus-idp/backstage-plugins](https://github.com/janus-idp/backstage-plugins).

## 1.4.1

### Patch Changes

- 0e6bfd3: feat: update Backstage to the latest version

  Update to Backstage 1.32.5

- 67f466a: Resolved the following issues:

  1. enabled validation using customValidate, and replaced extraErrors with getExtraErrors, since extraErrors is supposed to be populated when running onSubmit, and that isn't exposed to the user. Added busy handling while calling getExtraErrors.
  2. moved FormComponent to a separate component, to avoid buggy behavior and code smells with component generated in a different component.
  3. update formData on each change instead of when moving to next step, to avoid data being cleared.
  4. fix bug in validator - it only worked in first step, because of issue in @rjsf form
  5. removed unnecessary package json-schema that was used just for lint error, and fixed the root cause of lint error when importing types from @types/json-schema

## 1.4.0

### Minor Changes

- 8244f28: chore(deps): update to backstage 1.32

## 1.3.0

### Minor Changes

- d9551ae: feat(deps): update to backstage 1.31

### Patch Changes

- d9551ae: upgrade to yarn v3
