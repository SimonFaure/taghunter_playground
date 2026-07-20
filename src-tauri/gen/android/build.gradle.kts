buildscript {
    repositories {
        google()
        mavenCentral()
    }
    dependencies {
        classpath("com.android.tools.build:gradle:8.11.0")
        classpath("org.jetbrains.kotlin:kotlin-gradle-plugin:1.9.25")
    }
}

allprojects {
    repositories {
        google()
        mavenCentral()
        // mik3y/usb-serial-for-android is published on JitPack; required for
        // the SportIdent reader's Android transport (CP210x driver lives in
        // userspace on Android - see SportIdentSerial.kt).
        maven { url = uri("https://jitpack.io") }
    }
}

tasks.register("clean").configure {
    delete("build")
}

