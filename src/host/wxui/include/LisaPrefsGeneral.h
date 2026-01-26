#ifndef LISA_PREFS_GENERAL_H
#define LISA_PREFS_GENERAL_H

#include <wx/preferences.h>

class LisaPrefsGeneral : public wxStockPreferencesPage
{
public:
    LisaPrefsGeneral() : wxStockPreferencesPage(Kind_General) {}
    virtual wxWindow* CreateWindow(wxWindow* parent) override;
};

#endif
