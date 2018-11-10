# homebridge-garageio
Homebridge support for Garageio

Utilizes the APIs from the iOS mobile app to interface with Garageio to open and close garage doors.

Add Garageio to your platforms array in homebirdge config.json
"platforms": [
        {
                "platform": "Garageio",
                "username": "YOUR GARAGEIO USERNAME/EMAIL",
                "password": "YOUR GARAGEIO PASSWORD"
        }
    ]
