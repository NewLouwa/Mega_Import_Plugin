# MEGA Import Plugin

## Status: [CURRENT]
Last Updated: 2024-03-22
Version: 1.0.0

## Introduction
A Stash plugin for importing files from MEGA.nz cloud storage directly into your Stash library.

## Executive Summary
The MEGA Import plugin provides a seamless interface for importing files from MEGA.nz cloud storage into your Stash library. It features a modern UI with file browsing, selection, and import capabilities.

## Key Points
- Direct integration with MEGA.nz cloud storage
- Modern UI with file browser interface
- Secure authentication handling
- Progress tracking for imports
- Support for large file transfers

## Main Sections

### Features
- Browse MEGA.nz files and folders
- Select multiple files for import
- Track import progress
- Secure credential management
- Modern UI integration

### Technical Details
- Built using React for UI components
- Uses MEGA.nz API for file operations
- Integrates with Stash's plugin system
- Requires CommunityScriptsUILibrary

### Installation
1. Place plugin in `plugins/community/mega_import/`
2. Restart Stash server
3. Enable plugin in Settings > Plugins
4. Configure MEGA credentials in plugin settings

### Usage
1. Click the MEGA Import button in the navigation
2. Log in to your MEGA account
3. Browse and select files
4. Click Import to begin transfer

## Cross-References
- [Stash Plugin Documentation](https://github.com/stashapp/Stash/wiki/Plugins)
- [CommunityScriptsUILibrary](https://github.com/stashapp/CommunityScripts)

## Feedback
Please report issues and feature requests on the GitHub repository.

## Review History
- 2024-03-22: Initial release
- 2024-03-22: Added UI integration
- 2024-03-22: Updated plugin structure

## Changelog
- v1.0.0 (2024-03-22)
  - Initial release
  - Basic file browsing and import functionality
  - UI integration with navigation button 