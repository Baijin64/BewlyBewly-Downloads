# Keep JNI entry points invoked from Rust or loaded via System.loadLibrary
-keep class io.bewly.download.BewlyNative {
    *;
}
-keepclasseswithmembernames class * {
    native <methods>;
}

# Keep Kotlinx Serialization models used for Navigation3 keys
-keepattributes *Annotation*, InnerClasses
-dontnote kotlinx.serialization.AnnotationsKt
-keepclassmembers class kotlinx.serialization.json.** {
    *** Companion;
}
-keepclasseswithmembers class kotlinx.serialization.json.** {
    kotlinx.serialization.KSerializer serializer(...);
}
-keep,includedescriptorclasses class io.bewly.download.**$$serializer { *; }
-keepclassmembers class io.bewly.download.** {
    *** Companion;
}
