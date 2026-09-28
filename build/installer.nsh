; Uttr — extra steps for the Windows installer (NSIS script)
;
; electron-builder runs this during uninstall. If the user had turned on
; "Start Uttr when Windows starts", Windows keeps a "Uttr" entry in its
; startup list (the registry "Run" key). Remove it, so an uninstalled Uttr
; doesn't leave a broken startup item behind.

!macro customUnInstall
  DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "Uttr"
!macroend
