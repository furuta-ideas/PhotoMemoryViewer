# Bundled face detector

face-api.js 0.22.2 (MIT) includes TensorFlow.js core 1.7.0 (Apache 2.0).
TinyFaceDetector weights and the library are served from this application, with no external inference service.

Source: https://github.com/justadudewhohacks/face-api.js/tree/0.22.2
Files: dist/face-api.min.js; weights/tiny_face_detector_model-weights_manifest.json; weights/tiny_face_detector_model-shard1.
The shard is renamed with a .bin extension and the manifest path adjusted for static server MIME support. Weight bytes are unchanged.
Licenses: LICENSE and TENSORFLOW-LICENSE.
