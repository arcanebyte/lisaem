#include "LisaPrefsGeneral.h"
#include <wx/panel.h>
#include <wx/sizer.h>
#include <wx/stattext.h>

wxWindow* LisaPrefsGeneral::CreateWindow(wxWindow* parent)
{
    wxPanel* panel = new wxPanel(parent);
    wxBoxSizer* sizer = new wxBoxSizer(wxVERTICAL);
    
    wxStaticText* text = new wxStaticText(panel, wxID_ANY,
        "General preferences will go here.\n"
        "This is just a placeholder for now.");
    
    sizer->Add(text, 1, wxALL | wxEXPAND, 20);
    panel->SetSizer(sizer);
    
    return panel;
}
