void simpleFunc(float x) {
  if (x > 0.0) {
    x = 1.0;
  }
}

float conditionalFunc(vec3 dir) {
  float result = 0.0;
  #ifdef USE_FOG
  if (dir.y > 0.0) {
    result = dir.y;
  }
  #endif
  for (int i = 0; i < 4; i++) {
    result += 0.1;
  }
  return result;
}
