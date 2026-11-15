; Electron refuses to start when its install folder's ACL has an entry for one AppContainer
; package but none for ALL APPLICATION PACKAGES (S-1-15-2-1): sandboxed helper processes
; could not read the app's files. %LOCALAPPDATA%\Programs often inherits such entries from
; other apps, so grant ALL APPLICATION PACKAGES read/execute on DROPs' own folder.
!macro customInstall
  nsExec::ExecToLog 'icacls "$INSTDIR" /grant *S-1-15-2-1:(OI)(CI)(RX) /Q'
!macroend
