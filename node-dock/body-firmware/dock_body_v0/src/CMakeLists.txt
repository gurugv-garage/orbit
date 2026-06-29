idf_component_register(
    SRCS
        "main.c"
        "servo.c"
        "wifi_sta.c"
        "bodylink_proto.c"
        "bodylink_motion.c"
        "station_link.c"
        "station_ota.c"
    INCLUDE_DIRS "." "../include"
    REQUIRES
        esp_wifi
        nvs_flash
        esp_event
        esp_netif
        # Servo PWM backend is target-specific (see servo.c):
        #   ESP32-S3 → esp_driver_mcpwm   ESP32-C3 → esp_driver_ledc
        # Both are added below so either target links; the unused one is
        # harmless. (mcpwm has no hardware on C3 but the component still
        # builds as an empty stub.)
        esp_driver_mcpwm
        esp_driver_ledc
        esp_timer
        json
        esp_websocket_client
        esp_https_ota   # OTA over the station link (docs/OTA.md §4)
        app_update      # esp_ota_ops: slot select, mark-valid, rollback
        esp_http_client
        mbedtls         # sha256 verify of the downloaded image
)
