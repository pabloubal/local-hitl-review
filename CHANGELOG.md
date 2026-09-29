# [0.18.0](https://github.com/pabloubal/local-hitl-review/compare/v0.17.0...v0.18.0) (2026-09-29)


### Features

* **keybindings:** add default keybindings for core review actions ([#29](https://github.com/pabloubal/local-hitl-review/issues/29)) ([b010fc6](https://github.com/pabloubal/local-hitl-review/commit/b010fc6c1c4aed4468a089850a312c4528a28125)), closes [#13](https://github.com/pabloubal/local-hitl-review/issues/13)
* **review:** add resolved and wontfix status states ([#27](https://github.com/pabloubal/local-hitl-review/issues/27)) ([284c88d](https://github.com/pabloubal/local-hitl-review/commit/284c88dfb0a68a57e6c0368f2c55cc1fec099050)), closes [#10](https://github.com/pabloubal/local-hitl-review/issues/10)
* **ui:** add quick-pick filter for severity and status in tree view ([#28](https://github.com/pabloubal/local-hitl-review/issues/28)) ([6f165c4](https://github.com/pabloubal/local-hitl-review/commit/6f165c4cdf9d7a39e49877d4849bbe03cb04dc7b)), closes [#11](https://github.com/pabloubal/local-hitl-review/issues/11)

# [0.17.0](https://github.com/pabloubal/local-hitl-review/compare/v0.16.0...v0.17.0) (2026-09-28)


### Features

* **comments:** parse inline severity shorthand ([#9](https://github.com/pabloubal/local-hitl-review/issues/9)) ([#26](https://github.com/pabloubal/local-hitl-review/issues/26)) ([e789971](https://github.com/pabloubal/local-hitl-review/commit/e78997134fc72afd826ad7d21fed226bb731f38b))
* **prompt:** enrich copyAgentPrompt with review stats and file list ([#25](https://github.com/pabloubal/local-hitl-review/issues/25)) ([f9e2c1e](https://github.com/pabloubal/local-hitl-review/commit/f9e2c1ec2971843a0ac29ec20ed1a55211d49061)), closes [#6](https://github.com/pabloubal/local-hitl-review/issues/6)

# [0.16.0](https://github.com/pabloubal/local-hitl-review/compare/v0.15.0...v0.16.0) (2026-09-28)


### Features

* Add approve/finish review action ([#24](https://github.com/pabloubal/local-hitl-review/issues/24)) ([5f085ee](https://github.com/pabloubal/local-hitl-review/commit/5f085ee4620598df8244b6712f66478a1a8c178a)), closes [#6](https://github.com/pabloubal/local-hitl-review/issues/6)

# [0.15.0](https://github.com/pabloubal/local-hitl-review/compare/v0.14.0...v0.15.0) (2026-09-28)


### Features

* **comments:** restrict commenting to changed files only ([#23](https://github.com/pabloubal/local-hitl-review/issues/23)) ([96139d1](https://github.com/pabloubal/local-hitl-review/commit/96139d10e8a06d04987c164242a70e03c3dfc8c4))

# [0.14.0](https://github.com/pabloubal/local-hitl-review/compare/v0.13.0...v0.14.0) (2026-09-28)


### Features

* **tree:** build a feedback summary view in the tree ([#22](https://github.com/pabloubal/local-hitl-review/issues/22)) ([81748b5](https://github.com/pabloubal/local-hitl-review/commit/81748b551c307adf7e2ddb30e96649522978b6e1)), closes [#5](https://github.com/pabloubal/local-hitl-review/issues/5)

# [0.13.0](https://github.com/pabloubal/local-hitl-review/compare/v0.12.0...v0.13.0) (2026-09-28)


### Features

* **tree:** show comment count badges on file tree nodes ([#21](https://github.com/pabloubal/local-hitl-review/issues/21)) ([5f15983](https://github.com/pabloubal/local-hitl-review/commit/5f159835be09406f837bd2e8e87e27c906eac46f)), closes [#4](https://github.com/pabloubal/local-hitl-review/issues/4)

# [0.12.0](https://github.com/pabloubal/local-hitl-review/compare/v0.11.1...v0.12.0) (2026-09-27)


### Features

* **ui:** add next unreviewed file navigation command ([#17](https://github.com/pabloubal/local-hitl-review/issues/17)) ([0cbc4b2](https://github.com/pabloubal/local-hitl-review/commit/0cbc4b2e519618937072f415b156bbd7437d57e5)), closes [#3](https://github.com/pabloubal/local-hitl-review/issues/3)

## [0.11.1](https://github.com/pabloubal/local-hitl-review/compare/v0.11.0...v0.11.1) (2026-09-27)


### Bug Fixes

* **commentController:** preserve drafts and edits during store sync ([ef10fa4](https://github.com/pabloubal/local-hitl-review/commit/ef10fa40c9a46d910eb0554a065bb542371afe68)), closes [#2](https://github.com/pabloubal/local-hitl-review/issues/2)

# [0.11.0](https://github.com/pabloubal/local-hitl-review/compare/v0.10.0...v0.11.0) (2026-09-25)


### Bug Fixes

* create .gitignore inside feedback directory instead of root ([1423397](https://github.com/pabloubal/local-hitl-review/commit/1423397fccb929dd0a4c5cf7c41a79fac2c2e81c))


### Features

* add discardNewThread command and UI action to cancel new comment threads ([5cdac55](https://github.com/pabloubal/local-hitl-review/commit/5cdac553906021d5dc84b3bd4fb56746a2ab0193))
* support global and local scope path resolution in ReviewCommentController with unit tests ([1838d29](https://github.com/pabloubal/local-hitl-review/commit/1838d2921024132eb833cc36067c72eadc58444f))

# [0.10.0](https://github.com/pabloubal/local-hitl-review/compare/v0.9.0...v0.10.0) (2026-09-24)


### Features

* add auto-refresh for changed files on git state changes ([7d73182](https://github.com/pabloubal/local-hitl-review/commit/7d73182251f0684a7073aea8dc3bc0b65c264a46))

# [0.9.0](https://github.com/pabloubal/local-hitl-review/compare/v0.8.0...v0.9.0) (2026-09-23)


### Features

* add support for local feedback scope and multi-repository feedback management ([dd95eb8](https://github.com/pabloubal/local-hitl-review/commit/dd95eb851bb819937bb48a297dedae3a2e8b8d3a))

# [0.8.0](https://github.com/pabloubal/local-hitl-review/compare/v0.7.0...v0.8.0) (2026-09-22)


### Features

* include untracked files in git changes and display current branch in repository view ([ea21670](https://github.com/pabloubal/local-hitl-review/commit/ea2167003bf4b8c2466f816f07a4a662597b5c54))

# [0.7.0](https://github.com/pabloubal/local-hitl-review/compare/v0.6.0...v0.7.0) (2026-09-21)


### Features

* add defaultCompareMode configuration, compact tree folders, and native file decorations ([95fb068](https://github.com/pabloubal/local-hitl-review/commit/95fb0689dd7f9892c1a9ac9d9050356c3e5c1608))

# [0.6.0](https://github.com/pabloubal/local-hitl-review/compare/v0.5.0...v0.6.0) (2026-09-21)


### Features

* add multi-repository support across git service and changed files provider ([01a1eb9](https://github.com/pabloubal/local-hitl-review/commit/01a1eb91c652b26679101c288715a4b4f213866a))

# [0.5.0](https://github.com/pabloubal/local-hitl-review/compare/v0.4.0...v0.5.0) (2026-09-21)


### Features

* add copy agent prompt command, configurable agents file, and work-in-progress change view support ([64a0111](https://github.com/pabloubal/local-hitl-review/commit/64a01116f338814faff85435b8e4c9e2b79d891c))

# [0.4.0](https://github.com/pabloubal/local-hitl-review/compare/v0.3.1...v0.4.0) (2026-09-18)


### Features

* add support for viewing commit-specific file diffs ([23941aa](https://github.com/pabloubal/local-hitl-review/commit/23941aab7442c65a9cbd4c46a65309fba53d3498))

## [0.3.1](https://github.com/pabloubal/local-hitl-review/compare/v0.3.0...v0.3.1) (2026-09-18)


### Bug Fixes

* populate changed files using merge base in commits view ([a0e9794](https://github.com/pabloubal/local-hitl-review/commit/a0e9794b6b2015f6d9497f2d9dafdbb39d7b2b9e))

# [0.3.0](https://github.com/pabloubal/local-hitl-review/compare/v0.2.0...v0.3.0) (2026-09-18)


### Features

* add centralized logger, show logs command, and tree view enhancements ([96af28f](https://github.com/pabloubal/local-hitl-review/commit/96af28f2fd164d3d55d4018a020feb86a820b5bd))
* add output channel and execution logging for git commands ([eabecc8](https://github.com/pabloubal/local-hitl-review/commit/eabecc8aad404c76e697050e713169ed5e76a2b7))
* include remote branches in branch listing and base branch detection ([664e88d](https://github.com/pabloubal/local-hitl-review/commit/664e88db362a0cf0abbe31cb919588027fbfe361))

# [0.2.0](https://github.com/pabloubal/local-hitl-review/compare/v0.1.4...v0.2.0) (2026-09-17)


### Bug Fixes

* add .feedback directory to workspace root .gitignore ([f3e0e0b](https://github.com/pabloubal/local-hitl-review/commit/f3e0e0bd8f63124f1539edc783453e3822281eed))


### Features

* add commit graph view and commands to open commit changes ([be0dd00](https://github.com/pabloubal/local-hitl-review/commit/be0dd00f00008a6e3a768b8a32d63e11afdc6837))
